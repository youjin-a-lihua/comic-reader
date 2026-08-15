/**
 * 解密看门狗（常驻，与「自动解密」开关解耦）
 *
 * 设计目标：库内恒为明文，阅读器只读明文，不在请求路径上做整本解密
 * （原「开启自动解密时每次翻页 readFileSync 整本 + 写回」会打满 HC620 IO 致卡死）。
 *
 * 行为：
 *   - 进程启动即跑一次
 *   - 之后每 10 分钟扫一次（intervalMs 可配）
 *   - 扫描所有库，对仍为加密的 PDF 原地解密（保留 .enc.bak 备份）
 *   - 每个文件处理之间节流 1.2s，让出事件循环并错开 IO，绝不打满机械盘
 *
 * 覆盖所有导入来源（预加密 PDF / 手动拷贝等异常来源），
 * 作为「入库即解密」的兜底。
 *
 * 注意：
 *   - 漫画 id 由相对路径决定（lib/scanner.js 的 fileId），解密只改内容不改路径，
 *     进度/收藏等数据不会丢失。
 *   - 解密需要写回文件；若文件属主非 fncomic（如 root 身份导入）会 EACCES，
 *     需先 chown 给 fncomic（见解密失败日志提示）。
 */

'use strict';

const path = require('path');
const { decryptFileInPlace } = require('./decrypt');
const { scanAsync } = require('./scanner');
const { getSettings } = require('./settings');

let _running = false;

/**
 * 扫描所有库，原地解密仍为加密的 PDF。
 * @param {Array} libs 库列表 [{id, path, name}]
 * @returns {Promise<{scanned,decrypted,failed,errors,skipped}>}
 */
async function autoDecryptOnce(libs) {
  if (_running) return { skipped: true, scanned: 0, decrypted: 0, failed: 0, errors: [] };
  _running = true;
  const summary = { scanned: 0, decrypted: 0, failed: 0, errors: [] };
  try {
    const password = getSettings().decryptPassword || '11110000';
    const list = Array.isArray(libs) ? libs : [];

    for (const lib of list) {
      let comics;
      try {
        comics = await scanAsync(lib.path);
      } catch (e) {
        summary.errors.push(`库[${lib.path}] 扫描失败: ${e.message}`);
        continue;
      }
      for (const c of comics) {
        if (c.ext !== 'pdf') continue;
        summary.scanned++;
        try {
          const r = decryptFileInPlace(c.path, { ownerPassword: password, backup: true });
          if (r.ok && r.encrypted) {
            summary.decrypted++;
            console.log(`[autodecrypt] 已解密: ${c.relativePath || c.path}${r.backup ? ' (备份 ' + r.backup + ')' : ''}`);
          } else if (!r.ok) {
            summary.failed++;
            const hint = /EACCES/.test(r.reason || '')
              ? '（文件属主非 fncomic，需先 chown 给 fncomic 才能解密）'
              : '';
            summary.errors.push(`${c.relativePath || c.path}: ${r.reason}${hint}`);
          }
        } catch (e) {
          summary.failed++;
          summary.errors.push(`${c.relativePath || c.path}: ${e.message}`);
        }
        // 节流：每处理一个文件让出事件循环并错开 IO，避免打满机械盘
        await new Promise(res => setTimeout(res, 1200));
      }
    }
  } finally {
    _running = false;
  }
  return summary;
}

/**
 * 启动自动解密调度。依赖 server.js 传入 readLibs 以拿到当前库列表。
 * @param {Function} readLibs
 * @param {number} [intervalMs=600000] 默认 10 分钟
 */
function startAutoDecryptScheduler(readLibs, intervalMs = 10 * 60 * 1000) {
  const tick = async () => {
    try {
      const s = await autoDecryptOnce(readLibs());
      console.log(`[autodecrypt] 完成 扫描=${s.scanned} 解密=${s.decrypted} 失败=${s.failed}`);
      if (s.errors.length) console.warn('[autodecrypt] 错误:', s.errors.slice(0, 5));
    } catch (e) {
      console.error('[autodecrypt] 调度异常:', e.message);
    }
  };

  console.log('[autodecrypt] 常驻看门狗已启动（与开关解耦，覆盖所有导入来源，节流解密）');
  tick(); // 启动即跑一次
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { autoDecryptOnce, startAutoDecryptScheduler };
