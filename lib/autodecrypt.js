// Watchdog that decrypts PDFs in place, so the library is always plaintext.

'use strict';

const crypto = require('crypto');
const { decryptFileInPlace } = require('./decrypt');
const { scanAsync } = require('./scanner');
const { getSettings } = require('./settings');

let _running = false;
// 上一轮看到的库内容指纹（id+mtime+size）。内容没变就整轮跳过 ——
// 之前每轮都要对全库文件各读 256KB 尾部做加密嗅探，而在「库里全是明文 PDF」
// 这个最常见的稳态下，这些读全是白费。
let _lastFingerprint = '';
// 只处理 mtime 晚于上一次扫描开始的 PDF，避免每轮重扫全库尾部。
let _sinceMs = 0;
let _warnedOff = false;

async function autoDecryptOnce(libs) {
  if (_running) return { skipped: true, scanned: 0, decrypted: 0, failed: 0, errors: [] };
  _running = true;
  const summary = { scanned: 0, decrypted: 0, failed: 0, errors: [] };
  const runStartedAt = Date.now();
  try {
    // 必须先看开关：管理后台把「自动解密」关掉时，这个看门狗必须老实待着。
    // 原实现只判断密码是否为空，导致开关形同虚设 —— 实测 autoDecrypt=false 时
    // 仍在每轮扫描全库、逐本读尾 + 1.2s 节流，几乎占满全部时间。
    const settings = getSettings();
    if (!settings.autoDecrypt) {
      if (!_warnedOff) {
        console.log('[autodecrypt] 自动解密已关闭（settings.autoDecrypt=false），看门狗待机');
        _warnedOff = true;
      }
      return { ...summary, skipped: true };
    }
    _warnedOff = false;

    const password = settings.decryptPassword || process.env.DECRYPT_PASSWORD || '';
    if (!password) {
      console.warn('[autodecrypt] 未配置解密密码，跳过本轮（管理后台填写，或设置 DECRYPT_PASSWORD）');
      return summary;
    }
    const list = Array.isArray(libs) ? libs : [];

    // 1) 扫一遍，拿当前库内容指纹
    let comics = [];
    for (const lib of list) {
      try {
        comics = comics.concat(await scanAsync(lib.path));
      } catch (e) {
        summary.errors.push(`库[${lib.path}] 扫描失败: ${e.message}`);
      }
    }
    const fp = crypto.createHash('md5');
    for (const c of comics) fp.update(c.id + ':' + c.mtime + ':' + c.size + ';');
    const fingerprint = fp.digest('hex');
    if (fingerprint === _lastFingerprint) {
      // 库内容与上一轮完全一致：无新增/改动，不可能出现新的加密文件
      return { ...summary, skipped: true, unchanged: true };
    }
    _lastFingerprint = fingerprint;

    // 2) 只处理新增或改动的 PDF（首次运行 _sinceMs=0，全量过一遍）
    for (const c of comics) {
      if (c.ext !== 'pdf') continue;
      const mt = Date.parse(c.mtime) || 0;
      if (mt && mt <= _sinceMs) continue;
      summary.scanned++;
      try {
        const r = decryptFileInPlace(c.path, { ownerPassword: password, backup: true });
        if (r.ok && r.encrypted) {
          summary.decrypted++;
          console.log(`[autodecrypt] 已解密: ${c.relativePath || c.path}${r.backup ? ' (备份 ' + r.backup + ')' : ''}`);
          // 真的写了盘才节流，别对「只是看一眼尾部」也睡 1.2 秒
          await new Promise(res => setTimeout(res, 1200));
        } else if (!r.ok) {
          summary.failed++;
          const hint = /EACCES/.test(r.reason || '')
            ? '（文件属主不是容器运行用户，需先 chown 才能解密）'
            : '';
          summary.errors.push(`${c.relativePath || c.path}: ${r.reason}${hint}`);
        }
      } catch (e) {
        summary.failed++;
        summary.errors.push(`${c.relativePath || c.path}: ${e.message}`);
      }
    }
    _sinceMs = runStartedAt;
  } finally {
    _running = false;
  }
  return summary;
}

function startAutoDecryptScheduler(readLibs, intervalMs = 10 * 60 * 1000) {
  const tick = async () => {
    try {
      const s = await autoDecryptOnce(readLibs());
      if (s.skipped) return;             // 待机/无变化：不刷日志
      console.log(`[autodecrypt] 完成 扫描=${s.scanned} 解密=${s.decrypted} 失败=${s.failed}`);
      if (s.errors.length) console.warn('[autodecrypt] 错误:', s.errors.slice(0, 5));
    } catch (e) {
      console.error('[autodecrypt] 调度异常:', e.message);
    }
  };

  console.log('[autodecrypt] 看门狗已启动（受设置开关控制，增量 + 内容指纹门禁）');
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { autoDecryptOnce, startAutoDecryptScheduler };
