// Watchdog that decrypts PDFs in place, so the library is always plaintext.

'use strict';

const crypto = require('crypto');
const { decryptFileInPlace } = require('./decrypt');
const { scanAsync } = require('./scanner');
const { getSettings } = require('./settings');

let _running = false;
// Skip the whole cycle when the library fingerprint (id+mtime+size) is unchanged.
let _lastFingerprint = '';
// Only examine PDFs newer than the last run.
let _sinceMs = 0;
let _warnedOff = false;

async function autoDecryptOnce(libs) {
  if (_running) return { skipped: true, scanned: 0, decrypted: 0, failed: 0, errors: [] };
  _running = true;
  const summary = { scanned: 0, decrypted: 0, failed: 0, errors: [] };
  const runStartedAt = Date.now();
  try {
// Respect the autoDecrypt switch: a missing-password check alone left it running with the switch off.
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
      return { ...summary, skipped: true, unchanged: true };
    }
    _lastFingerprint = fingerprint;

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
      if (s.skipped) return;
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
