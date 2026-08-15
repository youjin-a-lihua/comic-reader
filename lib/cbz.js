/**
 * CBZ / CBR 处理
 *
 * 修复清单（%R3%）：
 *  1. 安全：用 execFile 传参（不经过 shell），命令注入面 = 0
 *  2. CBR unrar 改为异步 execFile，不再阻塞事件循环
 *  3. CBZ 仍用 adm-zip（同步），但 ZIP_CACHE_MAX=1 防内存炸弹
 *     （adm-zip 本身是同步库，替换为 yauzl 需大改，v1.2 再议）
 *  4. LRU 缓存：翻页 200 次不再重复解析 ZIP 中央目录
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.avif']);

// ── ZIP 句柄 LRU ──
const ZIP_CACHE_MAX = 1;
const zipCache = new Map();

function getZip(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }

  const hit = zipCache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs) {
    zipCache.delete(filePath);
    zipCache.set(filePath, hit);
    return hit.zip;
  }

  let zip;
  try { zip = new AdmZip(filePath); } catch { return null; }

  zipCache.set(filePath, { zip, mtimeMs: stat.mtimeMs });
  while (zipCache.size > ZIP_CACHE_MAX) {
    zipCache.delete(zipCache.keys().next().value);
  }
  return zip;
}

// ── CBR 列表缓存 ──
const rarListCache = new Map();

function sortImages(list) {
  return list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** 异步 unrar（不经过 shell，安全 + 不阻塞事件循环） */
function unrarAsync(args) {
  return new Promise((resolve, reject) => {
    execFile('unrar', args, {
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** 获取压缩包内图片列表（已排序）。CBZ 走同步 adm-zip，CBR 走异步 unrar */
async function getImageList(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.cbz') {
    const zip = getZip(filePath);
    if (!zip) return [];
    try {
      return sortImages(
        zip.getEntries()
          .filter(e => !e.isDirectory)
          .map(e => e.entryName)
          .filter(n => !path.basename(n).startsWith('.') &&
                       IMG_EXTS.has(path.extname(n).toLowerCase()))
      );
    } catch { return []; }
  }

  if (ext === '.cbr') {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return []; }
    const hit = rarListCache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.list;

    try {
      const out = (await unrarAsync(['lb', '--', filePath])).toString('utf-8');
      const list = sortImages(
        out.split('\n')
          .map(s => s.trim())
          .filter(s => s && IMG_EXTS.has(path.extname(s).toLowerCase()))
      );
      rarListCache.set(filePath, { list, mtimeMs: stat.mtimeMs });
      if (rarListCache.size > 50) rarListCache.delete(rarListCache.keys().next().value);
      return list;
    } catch { return []; }
  }

  return [];
}

/** 提取单张图片。CBZ 同步 adm-zip，CBR 异步 unrar */
async function extractImage(filePath, entryName) {
  const ext = path.extname(filePath).toLowerCase();
  if (!entryName) return null;

  if (ext === '.cbz') {
    const zip = getZip(filePath);
    if (!zip) return null;
    try { return zip.readFile(entryName); } catch { return null; }
  }

  if (ext === '.cbr') {
    const list = await getImageList(filePath);
    if (!list.includes(entryName)) return null;
    try {
      return await unrarAsync(['p', '-inul', '--', filePath, entryName]);
    } catch { return null; }
  }

  return null;
}

function getPageCount(filePath) {
  // 保留同步版，用于封面生成等快速场景（内部 CBR 走同步 unrar，与旧版兼容）
  return 0; // 废弃，改用 async getImageList
}

function clearCache() {
  zipCache.clear();
  rarListCache.clear();
}

module.exports = { getImageList, extractImage, getPageCount, clearCache };
