/**
 * 漫画/小说目录扫描模块
 * 递归扫描指定目录，发现 PDF / CBZ / CBR / EPUB 文件
 * 按父文件夹归组为"系列"
 * 支持 sidecar .meta.json 元数据合并
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const COMICS_DIR = process.env.COMICS_DIR || '/comics';
const SUPPORTED_EXTS = new Set(['.pdf', '.cbz', '.cbr', '.epub']);
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB 上限（应对超大长篇漫画PDF，原500MB会漏扫）

/**
 * 读取 sidecar .meta.json
 * 先查 PDF 同目录，再查 json/ 子目录
 * @param {string} filePath - 完整文件路径
 * @param {string} baseDir - 扫描根目录
 * @returns {object|null}
 */
function readMeta(filePath, baseDir) {
  const base = path.basename(filePath);
  const noExt = base.replace(/\.(pdf|cbz|cbr|epub)$/i, '');
  // 兼容两种 sidecar 命名约定（否则大量 <文件>.cbz.meta.json 会被当成"未分类"）：
  //   <原名>.meta.json      → vol1.cbz.meta.json（常见约定，保留扩展名）
  //   <去扩展名>.meta.json  → vol1.meta.json（旧约定，去掉扩展名）
  const metaNames = [`${base}.meta.json`, `${noExt}.meta.json`];
  const candidates = [];
  for (const m of metaNames) {
    candidates.push(path.join(path.dirname(filePath), m)); // 同目录
    candidates.push(path.join(baseDir, 'json', m));         // json/ 子目录
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
  }
  return null;
}

/** 异步版 readMeta（供 scanAsync 调用，不阻塞事件循环） */
async function readMetaAsync(filePath, baseDir) {
  const base = path.basename(filePath);
  const noExt = base.replace(/\.(pdf|cbz|cbr|epub)$/i, '');
  const metaNames = [`${base}.meta.json`, `${noExt}.meta.json`];
  const candidates = [];
  for (const m of metaNames) {
    candidates.push(path.join(path.dirname(filePath), m));
    candidates.push(path.join(baseDir, 'json', m));
  }
  for (const p of candidates) {
    try {
      await fsp.access(p);
      const raw = await fsp.readFile(p, 'utf-8');
      return JSON.parse(raw);
    } catch {}
  }
  return null;
}

/**
 * 为文件生成唯一 ID（基于相对路径的 SHA256 前 12 位）
 */
function fileId(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
}

/**
 * 递归扫描目录
 * @returns {Array} [{ id, name, path, relativePath, ext, size, series, mtime }]
 */
function scan(dir = COMICS_DIR) {
  const results = [];
  const baseDir = path.resolve(dir);

  if (!fs.existsSync(baseDir)) {
    return results;
  }

  function walk(currentDir, depth) {
    if (depth > 10) return; // 防止过深
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // 先收集文件
    const files = [];
    const subdirs = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          files.push({ name: entry.name, fullPath, ext });
        }
      }
    }

    // 当前目录是系列（有漫画文件）
    if (files.length > 0 || currentDir === baseDir) {
      const seriesName = currentDir === baseDir
        ? '未分类'
        : path.basename(currentDir);

      for (const file of files) {
        const relative = path.relative(baseDir, file.fullPath);
        const stat = fs.statSync(file.fullPath);
        if (stat.size > MAX_FILE_SIZE) continue; // 跳过超大文件
        const displayName = path.basename(file.name, file.ext);
        const ext = file.ext.slice(1); // pdf / cbz / cbr / epub

        // 读 sidecar meta.json
        const meta = readMeta(file.fullPath, baseDir);

        const result = {
          id: fileId(relative),
          name: (meta && meta.title && meta.title.trim()) || displayName,
          fullTitle: (meta && meta.fullTitle) || '',
          path: file.fullPath,
          relativePath: relative,
          ext,
          size: stat.size,
          series: (meta && meta.series && meta.series.trim()) || seriesName,
          mtime: stat.mtime.toISOString(),
          // meta.json 字段
          tags: (meta && meta.tags) || [],
          authors: (meta && meta.authors) || [],
          artists: (meta && meta.artists) || [],
          genres: (meta && meta.genres) || [],
          source: (meta && meta.source) || '',
          sourceId: (meta && meta.sourceId) || '',
          language: (meta && meta.language) || '',
          isTranslated: !!(meta && meta.isTranslated),
          status: (meta && meta.status) || 'unknown',
          publishedAt: (meta && meta.publishedAt) || '',
          pageCount: (meta && meta.pageCount) || 0,
          chapterCount: (meta && meta.chapterCount) || 1
        };

        // 标签兜底：没有系列名时用第一个标签
        if (result.series === '未分类' && result.tags.length > 0) {
          result.series = result.tags[0];
        }

        results.push(result);
      }
    }

    // 继续扫描子目录
    for (const sub of subdirs) {
      walk(sub, depth + 1);
    }
  }

  walk(baseDir, 0);

  // 按系列名排序，同系列内按文件名排序
  results.sort((a, b) => {
    if (a.series !== b.series) return a.series.localeCompare(b.series, 'zh');
    return a.name.localeCompare(b.name, 'zh');
  });

  return results;
}

/**
 * 异步递归扫描（基于 fs.promises，避免阻塞事件循环）
 * 与 scan() 返回值结构完全一致，可直接替换
 */
async function scanAsync(dir = COMICS_DIR) {
  const results = [];
  const baseDir = path.resolve(dir);

  try { await fsp.access(baseDir); } catch { return results; }

  async function walk(currentDir, depth) {
    if (depth > 10) return;
    let entries;
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch { return; }

    const files = [];
    const subdirs = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('@')) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTS.has(ext)) {
          files.push({ name: entry.name, fullPath, ext });
        }
      }
    }

    if (files.length > 0 || currentDir === baseDir) {
      const seriesName = currentDir === baseDir ? '未分类' : path.basename(currentDir);

      // 分批 stat，每批 50 个文件（防 HDD 并发惊群，避免 EMFILE + 磁头抖动）
      const CHUNK = 50;
      const stats = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        const batch = files.slice(i, i + CHUNK).map(f => fsp.stat(f.fullPath).catch(() => null));
        stats.push(...(await Promise.all(batch)));
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const stat = stats[i];
        if (!stat || stat.size > MAX_FILE_SIZE) continue;

        const relative = path.relative(baseDir, file.fullPath);
        const displayName = path.basename(file.name, file.ext);
        const ext = file.ext.slice(1);
        const meta = await readMetaAsync(file.fullPath, baseDir);

        const result = {
          id: fileId(relative),
          name: (meta && meta.title && meta.title.trim()) || displayName,
          fullTitle: (meta && meta.fullTitle) || '',
          path: file.fullPath,
          relativePath: relative,
          ext,
          size: stat.size,
          series: (meta && meta.series && meta.series.trim()) || seriesName,
          mtime: stat.mtime.toISOString(),
          tags: (meta && meta.tags) || [],
          authors: (meta && meta.authors) || [],
          artists: (meta && meta.artists) || [],
          genres: (meta && meta.genres) || [],
          source: (meta && meta.source) || '',
          sourceId: (meta && meta.sourceId) || '',
          language: (meta && meta.language) || '',
          isTranslated: !!(meta && meta.isTranslated),
          status: (meta && meta.status) || 'unknown',
          publishedAt: (meta && meta.publishedAt) || '',
          pageCount: (meta && meta.pageCount) || 0,
          chapterCount: (meta && meta.chapterCount) || 1
        };

        if (result.series === '未分类' && result.tags.length > 0) {
          result.series = result.tags[0];
        }

        results.push(result);
      }
    }

    // 子目录不并发（避免大量目录同时打开文件句柄）
    for (const sub of subdirs) {
      await walk(sub, depth + 1);
    }
  }

  await walk(baseDir, 0);

  results.sort((a, b) => {
    if (a.series !== b.series) return a.series.localeCompare(b.series, 'zh');
    return a.name.localeCompare(b.name, 'zh');
  });

  return results;
}

module.exports = { scan, scanAsync, readMeta, fileId, COMICS_DIR };
