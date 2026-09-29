// Watchdog that decrypts PDFs in place, so the library is always plaintext.

'use strict';

const path = require('path');
const { decryptFileInPlace } = require('./decrypt');
const { scanAsync } = require('./scanner');
const { getSettings } = require('./settings');

let _running = false;

async function autoDecryptOnce(libs) {
  if (_running) return { skipped: true, scanned: 0, decrypted: 0, failed: 0, errors: [] };
  _running = true;
  const summary = { scanned: 0, decrypted: 0, failed: 0, errors: [] };
  try {
    const password = getSettings().decryptPassword || 'REDACTED';
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
        // Throttle between files so the mechanical disk is never saturated.
        await new Promise(res => setTimeout(res, 1200));
      }
    }
  } finally {
    _running = false;
  }
  return summary;
}

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
  tick();
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { autoDecryptOnce, startAutoDecryptScheduler };
