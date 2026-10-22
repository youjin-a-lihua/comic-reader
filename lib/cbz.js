// CBZ (adm-zip) and CBR (unrar) page access, with an LRU over the ZIP handles.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.avif']);

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

const rarListCache = new Map();

function sortImages(list) {
  return list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

// Async unrar via execFile: no shell is involved.
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

// ── RAR 解压后端选择 ──────────────────────────────────
// unrar 在 Debian 属 non-free，官方镜像默认装不上/没装，导致 CBR 整体不可用。
// 这里加 bsdtar（libarchive-tools，Debian/Alpine 主仓库都有）作为回退，
// 命令语义与 unrar 一一对应：
//   unrar lb  <file>            <->  bsdtar -tf   <file>
//   unrar p   <file> <entry>    <->  bsdtar -xOf  <file> <entry>
let _rarBackend = null;   // 'unrar' | 'bsdtar'

function bsdtarAsync(args) {
  return new Promise((resolve, reject) => {
    execFile('bsdtar', args, {
      timeout: 20000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function rarListRaw(filePath) {
  if (_rarBackend !== 'bsdtar') {
    try {
      const out = await unrarAsync(['lb', '--', filePath]);
      _rarBackend = 'unrar';
      return out;
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;   // 有 unrar 但解不开 → 真错误
      _rarBackend = 'bsdtar';                  // 没装 unrar → 回退，之后不再试
    }
  }
  return bsdtarAsync(['-tf', filePath]);
}

async function rarExtractRaw(filePath, entryName) {
  if (_rarBackend !== 'bsdtar') {
    try {
      const out = await unrarAsync(['p', '-inul', '--', filePath, entryName]);
      _rarBackend = 'unrar';
      return out;
    } catch (e) {
      if (e && e.code !== 'ENOENT') throw e;
      _rarBackend = 'bsdtar';
    }
  }
  return bsdtarAsync(['-xOf', filePath, entryName]);
}

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
      const out = (await rarListRaw(filePath)).toString('utf-8');
      const list = sortImages(
        out.split('\n')
          .map(s => s.trim().replace(/^\.\//, ''))     // bsdtar 可能带 ./ 前缀
          .filter(s => s && IMG_EXTS.has(path.extname(s).toLowerCase()))
      );
      rarListCache.set(filePath, { list, mtimeMs: stat.mtimeMs });
      if (rarListCache.size > 50) rarListCache.delete(rarListCache.keys().next().value);
      return list;
    } catch { return []; }
  }

  return [];
}

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
      return await rarExtractRaw(filePath, entryName);
    } catch { return null; }
  }

  return null;
}

function getPageCount(filePath) {
  return 0;
}

function clearCache() {
  zipCache.clear();
  rarListCache.clear();
}

module.exports = { getImageList, extractImage, getPageCount, clearCache };
