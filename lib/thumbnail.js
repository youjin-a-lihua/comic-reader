/**
 * 封面缩略图
 *
 * 修复清单（相对旧版）：
 *  1. 【致命】cacheKey() 里带 fs.mkdirSync 副作用 —— 而 hasCover() 会调用它。
 *     结果：每次 /api/library 都会在 NAS 上 385 次 mkdir，并在所有漫画目录里
 *     撒下空的 .thumbnails 文件夹；只读挂载时还会直接抛错 500。
 *     现在拆成纯函数 cachePath() 与写入前才调用的 ensureDir()。
 *  2. PDF 现在服务端也能出封面（lib/pdfcover.js 直接抠第一张 JPEG）。
 *  3. 新增 saveCover()：前端 pdf.js 渲染完可回传缓存，全家设备共享。
 *  4. 媒体目录只读时自动降级到 DATA_DIR/thumbnails。
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { getImageList, extractImage } = require('./cbz');
const { extractPdfCover } = require('./pdfcover');
// 自动解密：开启后，封面生成遇到加密 PDF 时先纯 JS 原地解密到临时副本再抠封面
const { isEncryptedPdf, decryptPdfBuffer } = require('./decrypt');
const { getSettings } = require('./settings');
const Jimp = require('jimp');
// 测试/兜底开关：FORCE_DECRYPT_COVERS=1 时即使设置关闭也尝试解密封面
const ForceEnableDecrypt = (() => { try { return process.env.FORCE_DECRYPT_COVERS === '1'; } catch { return false; } })();

// 封面缩图：原图常 1000px 宽（280–390KB），手机列表只需 ~150px。
// 缩到宽 <=360px、quality 72，单封面降到 ~55KB，传输/解码快 5–7 倍（手机端关键优化）。
// 注意：Jimp 0.22 的 getBufferAsync(JPEG,{quality}) 选项无效，必须用 img.quality(n) 方法才生效。
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

// 记录哪些目录不可写，避免每次都试
const unwritable = new Set();

// hasCover 结果内存缓存：comicId -> 已解析的封面路径 或 null
// 避免 /api/library 对每本漫画都去 NAS 上做 fs.existsSync（几百本 = 上千次网络 stat）
const coverCache = new Map();

/** 纯函数：算出缓存文件应该在哪，不碰文件系统。
 *  封面缓存统一落到 DATA_DIR/thumbnails（compose 里挂到 vol3 SSD），
 *  不再写漫画同目录 .thumbnails（分散在 HC620 机械盘、stat 慢且占用源盘 IO）。 */
function cachePath(comicId, filePath) {
  if (!comicId) return null;
  return path.join(FALLBACK_DIR, `${comicId}.jpg`);
}

/** 只在真正要写入时调用 */
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

/** 查找已存在的封面（主位置 + 降级位置都查），结果进内存缓存 */
function resolveExisting(comicId, filePath) {
  if (coverCache.has(comicId)) return coverCache.get(comicId); // 可能是 null
  const primary = cachePath(comicId, filePath);
  if (primary && fs.existsSync(primary)) { coverCache.set(comicId, primary); return primary; }
  const fallback = path.join(FALLBACK_DIR, `${comicId}.jpg`);
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

// ── EPUB：属性顺序无关的解析（旧版正则强依赖 id→href→media-type 的顺序） ──

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

    // 1) <meta name="cover" content="id">
    const mc = opfXml.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*>/i);
    if (mc) {
      const coverId = parseAttrs(mc[0]).content;
      if (coverId) {
        const it = items.find(x => x.id === coverId);
        if (it && it.href) href = it.href;
      }
    }
    // 2) properties="cover-image"（EPUB3）
    if (!href) {
      const it = items.find(x => (x.properties || '').includes('cover-image'));
      if (it) href = it.href;
    }
    // 3) id / href 里带 cover 字样
    if (!href) {
      const it = items.find(x =>
        /^image\//i.test(x['media-type'] || '') &&
        /cover/i.test(`${x.id || ''} ${x.href || ''}`));
      if (it) href = it.href;
    }
    // 4) 第一张非 SVG 图片
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
    // 兜底：PDF 被加密导致抠不到首图时，纯 JS 原地解密到临时副本再抠
    try {
      const settings = getSettings();
      if (settings.autoDecrypt || ForceEnableDecrypt) {
        const buf = fs.readFileSync(filePath);
        if (isEncryptedPdf(buf)) {
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

/**
 * 生成/获取封面文件路径
 * 注意：保持 async 签名以兼容调用方，但内部是同步的，
 * 调用方必须 await（旧版路由漏了 await，是"封面返回 27 字节"的根因之一）
 *
 * 生成成功后会把路径写进 coverCache，后续 resolveExisting / hasCover 直接命中。
 */
async function generate(filePath, comicId) {
  const settings = getSettings();
  const allowRetry = settings.autoDecrypt || ForceEnableDecrypt;
  // 开启解密兜底时，清掉「封面缺失」的负缓存，允许重新尝试（加密 PDF 现已可解密抠图）
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

/** 前端 pdf.js 渲染完回传，落盘供其他设备复用 */
async function saveCover(comicId, filePath, buffer) {
  if (!buffer || buffer.length < 512 || buffer.length > 4 * 1024 * 1024) return null;
  // 必须是 JPEG / PNG
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  if (!isJpeg && !isPng) return null;
  const p = await writeCover(cachePath(comicId, filePath), buffer);
  if (p) coverCache.set(comicId, p);
  return p;
}

/**
 * 后台批量预生成封面（扫描完成后触发，不阻塞请求）
 *
 * - 已存在封面的直接跳过（走 coverCache，不再打 NAS stat）
 * - 用 setImmediate 在每本之间让出事件循环，预生成期间服务端请求仍可响应
 * - 单本失败不影响整体；_prewarming 防止重复触发叠加
 *
 * 可通过环境变量关闭：PREWARM_COVERS=0；并发数：PREWARM_CONCURRENCY（默认 3）
 */
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
        // 清除可能由 hasCover 提前写入的 null 缓存，
        // 确保 resolveExisting 真正走文件系统检测（而非直接返回缓存 null）
        coverCache.delete(c.id);
        if (!resolveExisting(c.id, c.path)) {
          await generate(c.path, c.id);
        }
      } catch (e) {
        // 单本失败（加密/损坏）不阻断整体
      }
      done++;
      // 让出事件循环，避免预生成把服务端请求全卡住
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
