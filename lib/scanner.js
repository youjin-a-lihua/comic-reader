// Recursive library scanner for PDF / CBZ / CBR / EPUB, with sidecar .meta.json support.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const COMICS_DIR = process.env.COMICS_DIR || '/comics';
const SUPPORTED_EXTS = new Set(['.pdf', '.cbz', '.cbr', '.epub']);
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB cap: long series produce PDFs above the old 500MB limit.

function readMeta(filePath, baseDir) {
  const base = path.basename(filePath);
  const noExt = base.replace(/\.(pdf|cbz|cbr|epub)$/i, '');
  // Two sidecar naming conventions: "vol1.cbz.meta.json" and "vol1.meta.json".
  const metaNames = [`${base}.meta.json`, `${noExt}.meta.json`];
  const candidates = [];
  for (const m of metaNames) {
    candidates.push(path.join(path.dirname(filePath), m));
    candidates.push(path.join(baseDir, 'json', m));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
  }
  return null;
}

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

function fileId(relativePath) {
  return crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 12);
}

function scan(dir = COMICS_DIR) {
  const results = [];
  const baseDir = path.resolve(dir);

  if (!fs.existsSync(baseDir)) {
    return results;
  }

  function walk(currentDir, depth) {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

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
      const seriesName = currentDir === baseDir
        ? '未分类'
        : path.basename(currentDir);

      for (const file of files) {
        const relative = path.relative(baseDir, file.fullPath);
        const stat = fs.statSync(file.fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const displayName = path.basename(file.name, file.ext);
        const ext = file.ext.slice(1);

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
          chapterCount: (meta && meta.chapterCount) || 1,
          // Pass the sidecar "type" through; scanAsync is the path the reader actually uses.
          metaType: (meta && meta.type) || ''
        };

        if (result.series === '未分类' && result.tags.length > 0) {
          result.series = result.tags[0];
        }

        results.push(result);
      }
    }

    for (const sub of subdirs) {
      walk(sub, depth + 1);
    }
  }

  walk(baseDir, 0);

  results.sort((a, b) => {
    if (a.series !== b.series) return a.series.localeCompare(b.series, 'zh');
    return a.name.localeCompare(b.name, 'zh');
  });

  return results;
}

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

      // Stat in batches of 50 to avoid EMFILE and mechanical-disk head thrashing.
      const CHUNK = 50;
      const stats = [];
      for (let i = 0; i < files.length; i += CHUNK) {
        const batch = files.slice(i, i + CHUNK).map(f => fsp.stat(f.fullPath).catch(() => null));
        stats.push(...(await Promise.all(batch)));
      }

      // Prefetch sidecar metadata in parallel; serial probing dominated full-rescan time.
      const META_CHUNK = 50;
      const metas = [];
      for (let i = 0; i < files.length; i += META_CHUNK) {
        metas.push(...(await Promise.all(
          files.slice(i, i + META_CHUNK).map(f => readMetaAsync(f.fullPath, baseDir))
        )));
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const stat = stats[i];
        if (!stat || stat.size > MAX_FILE_SIZE) continue;

        const relative = path.relative(baseDir, file.fullPath);
        const displayName = path.basename(file.name, file.ext);
        const ext = file.ext.slice(1);
        const meta = metas[i];

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
          chapterCount: (meta && meta.chapterCount) || 1,
          metaType: (meta && meta.type) || ''
        };

        if (result.series === '未分类' && result.tags.length > 0) {
          result.series = result.tags[0];
        }

        results.push(result);
      }
    }

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
