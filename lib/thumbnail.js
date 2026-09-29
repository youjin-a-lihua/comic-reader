// Cover thumbnails: path derivation, lookup, generation and background prewarming.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { getImageList, extractImage } = require('./cbz');
const { extractPdfCover } = require('./pdfcover');
const { isEncryptedPdf, decryptPdfBuffer } = require('./decrypt');
const { getSettings } = require('./settings');
const Jimp = require('jimp');
const ForceEnableDecrypt = (() => { try { return process.env.FORCE_DECRYPT_COVERS === '1'; } catch { return false; } })();

// Jimp 0.22 ignores the quality option of getBufferAsync; img.quality(n) is what works.
async function shrinkCover(buffer) {
  if (!buffer || buffer.length < 1024) return buffer;
  try {
    const img = await Jimp.read(buffer);
    const MAX_W = 360;
    if (img.bitmap.width > MAX_W) img.resize(MAX_W, Jimp.AUTO);
    img.quality(72);
    return await img.getBufferAsync(Jimp.MIME_JPEG);
  } catch (e) {
    console.error('[thumbnail] 缩图失败，回退原图:', e.message);
    return buffer;
  }
}

const FALLBACK_DIR = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'thumbnails'
);

const unwritable = new Set();

const coverCache = new Map();

// The fallback cover name hashes the absolute path, so two comics can never share a file.
function fallbackName(filePath) {
  const abs = path.resolve(filePath || '');
  return crypto.createHash('md5').update(abs).digest('hex').slice(0, 16) + '.jpg';
}

// cachePath() must stay side-effect free: mkdir inside hasCover() created hundreds of dirs per request.
function cachePath(comicId, filePath) {
  if (!comicId) return null;
  return path.join(FALLBACK_DIR, fallbackName(filePath));
}

// ensureDir() is called only right before an actual write.
function ensureDir(target) {
  const dir = path.dirname(target);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return target;
  } catch {
    unwritable.add(dir);
    try {
      if (!fs.existsSync(FALLBACK_DIR)) fs.mkdirSync(FALLBACK_DIR, { recursive: true });
    } catch {}
    return path.join(FALLBACK_DIR, path.basename(target));
  }
}

async function writeCover(target, buffer) {
  if (!buffer || buffer.length === 0) return null;
  let out = buffer;
  try { out = await shrinkCover(buffer); } catch { out = buffer; }
  const real = ensureDir(target);
  try {
    const tmp = `${real}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, real);
    return real;
  } catch (err) {
    console.error('[thumbnail] 写入封面失败:', err.message);
    return null;
  }
}

function resolveExisting(comicId, filePath) {
  if (coverCache.has(comicId)) return coverCache.get(comicId);
  const primary = cachePath(comicId, filePath);
  if (primary && fs.existsSync(primary)) { coverCache.set(comicId, primary); return primary; }
  const fallback = path.join(FALLBACK_DIR, fallbackName(filePath));
  if (fs.existsSync(fallback)) { coverCache.set(comicId, fallback); return fallback; }
  coverCache.set(comicId, null);
  return null;
}

async function generateArchiveCover(filePath, comicId) {
  try {
    const images = await getImageList(filePath);
    if (images.length === 0) return null;
    const first = await extractImage(filePath, images[0]);
    return writeCover(cachePath(comicId, filePath), first);
  } catch (err) {
    console.error('[thumbnail] CBZ/CBR 封面失败:', err.message);
    return null;
  }
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    if (m[1] !== undefined) attrs[m[1].toLowerCase()] = m[2];
    else attrs[m[3].toLowerCase()] = m[4];
  }
  return attrs;
}

function parseManifestItems(opfXml) {
  const items = [];
  const re = /<item\b[^>]*>/gi;
  let m;
  while ((m = re.exec(opfXml)) !== null) items.push(parseAttrs(m[0]));
  return items;
}

function generateEpubCover(filePath, comicId) {
  try {
    const zip = new AdmZip(filePath);

    const cxmlBuf = zip.readFile('META-INF/container.xml');
    if (!cxmlBuf) return null;
    const cxml = cxmlBuf.toString('utf-8');
    const cm = cxml.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (!cm) return null;
    const opfPath = cm[1];

    const opfBuf = zip.readFile(opfPath);
    if (!opfBuf) return null;
    const opfXml = opfBuf.toString('utf-8');
    const opfDir = path.dirname(opfPath);
    const items = parseManifestItems(opfXml);

    let href = null;

    const mc = opfXml.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i);
    if (mc) {
      const coverId = parseAttrs(mc[0]).content;
      if (coverId) {
        const it = items.find(x => x.id === coverId);
        if (it && it.href) href = it.href;
      }
    }
    if (!href) {
      const it = items.find(x => (x.properties || '').includes('cover-image'));
      if (it) href = it.href;
    }
    if (!href) {
      const it = items.find(x =>
        /^image\//i.test(x['media-type'] || '') &&
        /cover/i.test(`${x.id || ''} ${x.href || ''}`));
      if (it) href = it.href;
    }
    if (!href) {
      const it = items.find(x =>
        /^image\//i.test(x['media-type'] || '') && !/svg/i.test(x['media-type']));
      if (it) href = it.href;
    }
    if (!href) return null;

    const decoded = decodeURIComponent(href);
    const full = (opfDir === '.' || opfDir === '')
      ? decoded
      : path.join(opfDir, decoded).replace(/\\/g, '/');

    let buffer = zip.readFile(full);
    if (!buffer) buffer = zip.readFile(decoded);
    if (!buffer) {
      const base = path.basename(full);
      const hit = zip.getEntries().map(e => e.entryName).find(n => n.endsWith(base));
      if (hit) buffer = zip.readFile(hit);
    }

    return writeCover(cachePath(comicId, filePath), buffer);
  } catch (err) {
    console.error('[thumbnail] EPUB 封面失败:', err.message);
    return null;
  }
}

function generatePdfCover(filePath, comicId) {
  let jpeg = extractPdfCover(filePath);
  if (!jpeg) {
    try {
      const settings = getSettings();
      if (settings.autoDecrypt || ForceEnableDecrypt) {
        const buf = fs.readFileSync(filePath);
        if (settings.decryptPassword && isEncryptedPdf(buf)) {
          const res = decryptPdfBuffer(buf, { ownerPassword: settings.decryptPassword });
          if (res.ok) {
            const tmp = `${filePath}.dec.tmp-${process.pid}`;
            try {
              fs.writeFileSync(tmp, res.buf);
              jpeg = extractPdfCover(tmp);
            } finally {
              try { fs.unlinkSync(tmp); } catch {}
            }
          }
        }
      }
    } catch (e) {
      console.error('[thumbnail] PDF 解密兜底失败:', e.message);
    }
  }
  if (!jpeg) return null;
  return writeCover(cachePath(comicId, filePath), jpeg);
}

async function generate(filePath, comicId) {
  const settings = getSettings();
  const allowRetry = settings.autoDecrypt || ForceEnableDecrypt;
  if (allowRetry) coverCache.delete(comicId);

  const existing = resolveExisting(comicId, filePath);
  if (existing) return existing;

  const ext = path.extname(filePath || '').toLowerCase();
  let out = null;
  if (ext === '.cbz' || ext === '.cbr') out = await generateArchiveCover(filePath, comicId);
  else if (ext === '.epub') out = generateEpubCover(filePath, comicId);
  else if (ext === '.pdf') out = generatePdfCover(filePath, comicId);
  if (out) coverCache.set(comicId, out);
  return out;
}

function get(comicId, filePath) {
  const p = resolveExisting(comicId, filePath);
  return p ? fs.readFileSync(p) : null;
}

function hasCover(comicId, filePath) {
  return !!resolveExisting(comicId, filePath);
}

async function saveCover(comicId, filePath, buffer) {
  if (!buffer || buffer.length < 512 || buffer.length > 4 * 1024 * 1024) return null;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  if (!isJpeg && !isPng) return null;
  const p = await writeCover(cachePath(comicId, filePath), buffer);
  if (p) coverCache.set(comicId, p);
  return p;
}

const PREWARM_ENABLED = (process.env.PREWARM_COVERS || '1') !== '0';
const PREWARM_CONCURRENCY = Math.max(1, parseInt(process.env.PREWARM_CONCURRENCY || '3', 10) || 3);
let _prewarming = false;

async function prewarm(comics) {
  if (!PREWARM_ENABLED) return;
  if (!Array.isArray(comics) || comics.length === 0) return;
  if (_prewarming) return;
  _prewarming = true;

  const queue = comics.slice();
  const total = queue.length;
  let done = 0;
  console.log(`[prewarm] 启动封面预生成：共 ${total} 本，并发 ${PREWARM_CONCURRENCY}`);

  async function worker() {
    while (queue.length > 0) {
      const c = queue.shift();
      try {
        coverCache.delete(c.id);
        if (!resolveExisting(c.id, c.path)) {
          await generate(c.path, c.id);
        }
      } catch (e) {
      }
      done++;
      // Yield to the event loop between covers so prewarming cannot stall live requests.
      await new Promise(r => setImmediate(r));
    }
  }

  const n = Math.max(1, Math.min(PREWARM_CONCURRENCY, total));
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(worker());
  try {
    await Promise.all(ps);
  } finally {
    _prewarming = false;
  }
  console.log(`[prewarm] 完成 ${done}/${total}`);
}

module.exports = { generate, prewarm, get, hasCover, saveCover, cachePath };
