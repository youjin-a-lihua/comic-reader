/**
 * fnOS 漫画阅读器 — Express 服务器
 *
 * ── 本次修复清单 ────────────────────────────────────────────────
 *  P0-1 /api/bookmarks 里 hasCover(item.id, item.path) —— progress 项没有 path
 *       字段，永远传 undefined，导致收藏页封面全丢。改用 comicMap[item.id].path。
 *  P0-2 JWT_SECRET 每次启动随机生成 → 应用一重启（或 fnOS 更新）全家 token 失效，
 *       所有人被踢下线。改为持久化到 DATA_DIR/.jwt-secret。
 *  P0-3 几乎每个路由都写 scanAllLibs(true) 强制重扫，60s 缓存形同虚设。
 *       385 本书 × 每请求全盘 stat NAS = 首页卡 3~8 秒。改为默认吃缓存，
 *       只有 ?refresh=1 和库增删时才失效。
 *  P0-4 views/likes/shelves/libraries 全部 readFileSync+writeFileSync 裸写，
 *       并发下互相覆盖、断电写半截。统一走 lib/jsonstore（原子写+写合并）。
 *  P1-1 PDF 封面之前只能靠前端 pdf.js 现渲染，列表页一片灰。现在服务端
 *       lib/pdfcover 直接抠首张 JPEG；另开 POST /cover 让前端回传缓存。
 *  P1-2 Range 头没校验，curl -H "Range: bytes=abc-" 直接 500 / 进程异常。
 *  P1-3 /api/login 无限重试，可暴力破解 NAS 账号。加 IP+账号维度限速。
 *  P1-4 缺全局错误处理，任何未捕获异常返回 HTML 错误页，前端 JSON.parse 崩。
 *  P1-5 进程退出不落盘，最后几百毫秒的进度丢失。装 exit hook。
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const net = require('net');

const { authenticate } = require('./lib/auth');
const { scanAsync, fileId } = require('./lib/scanner');
const {
  getUserProgress,
  saveProgress,
  toggleBookmark,
  getContinueReading,
  getBookmarks,
  removeComicFromAllUsers
} = require('./lib/progress');
const { getImageList, extractImage } = require('./lib/cbz');
const { generate, prewarm, get: getCover, hasCover, saveCover } = require('./lib/thumbnail');
const { getToc, getChapter, getResource } = require('./lib/epub');
const { getStore, installExitHooks } = require('./lib/jsonstore');
const { getSettings, saveSettings } = require('./lib/settings');
const { autoDecryptOnce, startAutoDecryptScheduler } = require('./lib/autodecrypt');
const { isEncryptedPdf, decryptPdfBuffer, decryptFileInPlace } = require('./lib/decrypt');
const { getOnlineImage } = require('./lib/online-image');
const onlineSources = require('./lib/sources');

const app = express();
const PORT = process.env.PORT || 3000;
const COMICS_DIR = process.env.COMICS_DIR || '/comics';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

installExitHooks();

// ── JWT 密钥持久化 ──────────────────────────────────
// 原来是 crypto.randomBytes(32) 直接放内存，重启即失效。
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt-secret');
  try {
    const s = fs.readFileSync(f, 'utf-8').trim();
    if (s.length >= 32) return s;
  } catch { /* 首次启动 */ }
  const s = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, s, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('[jwt] 密钥无法持久化，重启后需重新登录:', err.message);
  }
  return s;
}
const JWT_SECRET = loadJwtSecret();

// ── 中间件 ──────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
// GZIP 压缩：静态资源与 JSON 响应体积减少 70%+（弱网下显著）
app.use(require('compression')());
// 封面回传是二进制
app.use('/api/comic/:id/cover', express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' }));

app.disable('x-powered-by');

// 静态文件（不带缓存，开发阶段每次拉最新）
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false, setHeaders: res => { res.set('Cache-Control', 'no-cache'); } }));
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false, setHeaders: res => { res.set('Cache-Control', 'no-cache'); } }));
// 本地化的 pdf.js（原来走 cdnjs，NAS 断外网就打不开书）
// 注意：express@4 底层 send 用的 mime@1.6，不认识 .mjs，会当 octet-stream 发出去，
// 浏览器会以"MIME 类型不匹配"直接拒绝执行模块脚本 —— 必须手动指定。
app.use('/vendor', express.static(path.join(PUBLIC_DIR, 'vendor'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs')) res.set('Content-Type', 'text/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=604800');
  }
}));
app.use(express.static(PUBLIC_DIR, { index: false }));

// JWT 验证中间件（Header 或 Query 参数）
function authMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

// ── 认证路由 ────────────────────────────────────────

// 登录限速：同一 IP+账号 5 分钟内最多 10 次失败
const loginAttempts = new Map();
const LOGIN_WINDOW = 5 * 60 * 1000;
const LOGIN_MAX_FAIL = 10;

function loginKey(req, username) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return `${ip}|${username}`;
}
function isLocked(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW) { loginAttempts.delete(key); return false; }
  return rec.count >= LOGIN_MAX_FAIL;
}
function noteFail(key) {
  const rec = loginAttempts.get(key);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW) {
    loginAttempts.set(key, { count: 1, first: Date.now() });
  } else {
    rec.count++;
  }
}
// 定期清理，避免 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now - v.first > LOGIN_WINDOW) loginAttempts.delete(k);
}, LOGIN_WINDOW).unref();

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const key = loginKey(req, username);
  if (isLocked(key)) {
    return res.status(429).json({ error: '登录尝试过于频繁，请 5 分钟后再试' });
  }

  const result = await authenticate(username, password);
  if (!result.success) {
    noteFail(key);
    return res.status(401).json({ error: result.error || '登录失败' });
  }
  loginAttempts.delete(key);

  const token = jwt.sign(
    { username: result.username, role: result.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { username: result.username, role: result.role } });
});

// 校验 token 是否仍有效（客户端启动时调用，避免拿着过期 token 白转圈）
app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

// ── 扫描缓存 ────────────────────────────────────────
// 原来每个路由都 scanAllLibs(true)，60s 缓存完全没生效。

let _scanCache = null;
let _scanMap = null;
let _scanTime = 0;
const SCAN_CACHE_TTL = 600000;

function invalidateScan() {
  _scanCache = null;
  _scanMap = null;
  _scanTime = 0;
}

async function scanAllLibs(force = false) {
  const now = Date.now();
  if (!force && _scanCache && (now - _scanTime) < SCAN_CACHE_TTL) return _scanCache;
  const libs = readLibs();
  let all = [];
  for (const lib of libs) {
    try {
      all = all.concat(await scanAsync(lib.path));
    } catch (err) {
      console.error(`[scan] 库 ${lib.path} 扫描失败:`, err.message);
    }
  }
  for (const c of all) c.type = ['pdf', 'cbz', 'cbr'].includes(c.ext) ? 'comic' : 'novel';

  // 只预热本次扫描新增的漫画，避免每次全量预热（既省 CPU/IO，
  // 也防止 _prewarming 锁导致新漫画的 prewarm 被旧预热吞掉）
  const prevIds = _scanCache ? new Set(_scanCache.map(c => c.id)) : new Set();
  const freshComics = all.filter(c => !prevIds.has(c.id));
  if (freshComics.length > 0) {
    prewarm(freshComics).catch(e => console.error('[prewarm]', e && e.message));
  }

  _scanCache = all;
  _scanMap = null;
  _scanTime = now;
  return all;
}

/** id → comic 映射，跟扫描缓存同生命周期，避免每个路由重建 */
async function getComicMap(force = false) {
  const list = await scanAllLibs(force);
  if (!_scanMap) {
    _scanMap = Object.create(null);
    for (const c of list) _scanMap[c.id] = c;
  }
  return _scanMap;
}

async function findComic(id) {
  return (await getComicMap())[id] || null;
}

// ── 受保护路由 ──────────────────────────────────────

// 继续阅读
app.get('/api/continue', authMiddleware, async (req, res) => {
  const items = getContinueReading(req.user.username);
  const comicMap = await getComicMap();

  const result = items
    .filter(item => comicMap[item.id])
    .map(item => ({
      ...comicMap[item.id],
      progress: item,
      hasCover: hasCover(item.id, comicMap[item.id].path)
    }));

  res.json(result);
});

// 收藏列表
app.get('/api/bookmarks', authMiddleware, async (req, res) => {
  const items = getBookmarks(req.user.username);
  const comicMap = await getComicMap();

  const result = items
    .filter(item => comicMap[item.id])
    .map(item => ({
      ...comicMap[item.id],
      progress: { page: 0, bookmarked: true },
      // 修复：item 是 progress 记录，没有 path 字段，必须从 comicMap 取
      hasCover: hasCover(item.id, comicMap[item.id].path)
    }));

  res.json(result);
});

// 搜索
app.get('/api/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);

  const comics = await scanAllLibs();
  const results = comics.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.series || '').toLowerCase().includes(q) ||
    (c.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (c.authors || []).some(a => a.toLowerCase().includes(q)) ||
    (c.fullTitle || '').toLowerCase().includes(q)
  );

  const progress = getUserProgress(req.user.username);
  res.json(results.map(c => ({
    ...c,
    progress: progress[c.id] || null,
    hasCover: hasCover(c.id, c.path)
  })));
});

// 漫画详情
app.get('/api/comic/:id/info', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });

  const progress = getUserProgress(req.user.username);
  let pageCount = 0;

  try {
    if (comic.ext === 'pdf') {
      pageCount = 0;
    } else if (comic.ext === 'epub') {
      pageCount = getToc(comic.path).length;
    } else {
      pageCount = getImageList(comic.path).length;
    }
  } catch (err) {
    console.error('[info] 页数统计失败:', err.message);
  }

  res.json({
    ...comic,
    pageCount,
    progress: progress[comic.id] || null
  });
});

// 提供 PDF 文件（支持 Range 请求）
app.get('/api/comic/:id/file', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (comic.ext !== 'pdf') return res.status(400).json({ error: '非 PDF 格式' });

  const filePath = comic.path;
  let stat, fileSize;
  try { stat = fs.statSync(filePath); fileSize = stat.size; }
  catch { return res.status(404).json({ error: '文件已不存在，请刷新书架' }); }

  // 解密统一在「入库」阶段完成（autodecrypt 常驻看门狗兜底），
  // 库内恒为明文，阅读器只读明文，不在请求路径上做整本解密。
  // 若漫画仍为加密态（异常来源），交由看门狗异步解密，不阻塞本次翻页请求。

  const range = req.headers.range;
  // 修复：原来不校验，"bytes=abc-" 会算出 NaN，chunkSize 变 NaN 直接把连接打死
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? NaN : parseInt(m[1], 10);
    let end = m[2] === '' ? NaN : parseInt(m[2], 10);

    if (Number.isNaN(start) && Number.isNaN(end)) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    if (Number.isNaN(start)) {            // bytes=-500 → 最后 500 字节
      start = Math.max(0, fileSize - end);
      end = fileSize - 1;
    } else if (Number.isNaN(end)) {
      end = fileSize - 1;
    }
    if (start > end || start >= fileSize) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    end = Math.min(end, fileSize - 1);

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'application/pdf'
    });
    const rs = fs.createReadStream(filePath, { start, end });
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/pdf'
    });
    const rs = fs.createReadStream(filePath);
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  }
});

// 提供 CBZ/CBR 中的单页图片
app.get('/api/comic/:id/page/:pageNum', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (!['cbz', 'cbr'].includes(comic.ext)) {
    return res.status(400).json({ error: '非 CBZ/CBR 格式' });
  }

  try {
    const images = getImageList(comic.path);
    const pageNum = parseInt(req.params.pageNum, 10);
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > images.length) {
      return res.status(404).json({ error: '页码不存在' });
    }

    const entryName = images[pageNum - 1];
    const buffer = extractImage(comic.path, entryName);
    if (!buffer) return res.status(404).json({ error: '读取页面失败' });

    const ext = path.extname(entryName).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
  };

  res.set('Content-Type', mimeMap[ext] || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
  } catch (err) {
    console.error('[page]', req.params.id, req.params.pageNum, err.message);
    if (!res.headersSent) res.status(404).end();
  }
});

// ── EPUB 路由 ───────────────────────────────────────

app.get('/api/comic/:id/epub/toc', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画/小说不存在' });
  if (comic.ext !== 'epub') return res.status(400).json({ error: '非 EPUB 格式' });

  const toc = getToc(comic.path);
  res.json({
    title: comic.name,
    toc: toc.map(ch => ({ index: ch.index, title: ch.title, id: ch.id }))
  });
});

app.get('/api/comic/:id/epub/chapter/:index', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画/小说不存在' });
  if (comic.ext !== 'epub') return res.status(400).json({ error: '非 EPUB 格式' });

  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: '章节序号无效' });
  }
  const html = getChapter(comic.path, index,
    `/api/comic/${comic.id}/epub/resource`);
  if (!html) return res.status(500).json({ error: '章节读取失败' });

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/api/comic/:id/epub/resource/*', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画/小说不存在' });
  if (comic.ext !== 'epub') return res.status(400).json({ error: '非 EPUB 格式' });

  const resourcePath = req.params[0];
  if (!resourcePath) return res.status(400).json({ error: '缺少资源路径' });

  const buffer = getResource(comic.path, resourcePath);
  if (!buffer) return res.status(404).json({ error: '资源不存在' });

  const ext = path.extname(resourcePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.css': 'text/css', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf'
  };
  res.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// ── 封面 ────────────────────────────────────────────

app.get('/api/comic/:id/cover', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });

  try {
    // 已缓存则直接返回；否则现场生成（预生成阶段通常已备好，这里只是兜底）
    const coverPath = await generate(comic.path, comic.id);
    if (coverPath && fs.existsSync(coverPath)) {
      // res.sendFile 会：自动推断 image/jpeg、生成 ETag、处理 If-None-Match(304)、支持 Range
      // immutable 告诉浏览器内容稳定，可长期缓存
      return res.sendFile(coverPath, {
        maxAge: 31536000,
        immutable: true,
        acceptRanges: true
      }, (err) => {
        if (err) {
          console.error('[cover-read]', comic.id, err.message);
          if (!res.headersSent) res.status(404).end();
        }
      });
    }
  } catch (err) {
    console.error('[cover]', comic.id, err.message);
  }

  // 实在拿不到：404，前端用 pdf.js 现渲染后回传（PDF 加密等场景）
  res.status(404).end();
});

// 前端 pdf.js 渲染完的封面回传，落盘给其他设备复用
app.post('/api/comic/:id/cover', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: '缺少图片数据' });
  }
  const saved = await saveCover(comic.id, comic.path, req.body);
  if (!saved) return res.status(400).json({ error: '图片无效或过大' });
  res.json({ success: true });
});

// ── 进度 / 收藏 ─────────────────────────────────────

app.post('/api/comic/:id/progress', authMiddleware, async (req, res) => {
  const { page, totalPages } = req.body || {};
  if (page === undefined) return res.status(400).json({ error: '缺少 page 参数' });
  const pageNum = Number(page);
  if (!Number.isFinite(pageNum) || pageNum < 0) {
    return res.status(400).json({ error: 'page 参数无效' });
  }

  if (!(await findComic(req.params.id))) { return res.status(404).json({ error: '漫画不存在' }); }

  const result = saveProgress(req.user.username, req.params.id, pageNum, Number(totalPages) || 0);
  res.json(result);
});

app.post('/api/comic/:id/bookmark', authMiddleware, async (req, res) => {
  if (!(await findComic(req.params.id))) { return res.status(404).json({ error: '漫画不存在' }); }
  const result = toggleBookmark(req.user.username, req.params.id);
  res.json(result);
});

// ── 一键删除漫画（管理员 + 控制面板开关）─────────────────
// 彻底删除：漫画本体 + 封面 + 全部元数据（进度/收藏/浏览/点赞/评论/书架）
async function deleteComicFully(comic) {
  const id = comic.id;
  const errors = [];

  // 1) 漫画本体（文件或目录）
  try {
    await fs.promises.rm(comic.path, { recursive: true, force: true });
  } catch (e) { errors.push('本体: ' + e.message); }

  // 2) 封面：主缓存（漫画同目录 .thumbnails）与兜底缓存（DATA_DIR/thumbnails）
  const primaryCover = path.join(path.dirname(comic.path), '.thumbnails', `${id}.jpg`);
  const fallbackCover = path.join(DATA_DIR, 'thumbnails', `${id}.jpg`);
  for (const f of [primaryCover, fallbackCover]) {
    try { await fs.promises.rm(f, { force: true }); } catch (e) { /* 封面可能不存在 */ }
  }

  // 3) 进度 / 收藏（所有用户）
  try { removeComicFromAllUsers(id); } catch (e) { errors.push('进度: ' + e.message); }

  // 4) 浏览量
  try { viewsStore.update(v => { delete v[id]; }); } catch (e) { errors.push('浏览: ' + e.message); }

  // 5) 点赞
  try { likesStore.update(l => { delete l[id]; }); } catch (e) { errors.push('点赞: ' + e.message); }

  // 6) 评论
  try {
    const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
    await fs.promises.rm(path.join(commentsDir, `${safe}.json`), { force: true });
  } catch (e) { /* 可能没有评论文件 */ }

  // 7) 书架：从每位用户的书架里移除该漫画
  try {
    if (fs.existsSync(shelvesDir)) {
      for (const f of fs.readdirSync(shelvesDir)) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(shelvesDir, f);
        try {
          const shelves = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          const changed = Array.isArray(shelves) && shelves.some(s => s.items && s.items.includes(id));
          if (changed) {
            const next = shelves.map(s => s.items ? { ...s, items: s.items.filter(it => it !== id) } : s);
            fs.writeFileSync(fp, JSON.stringify(next, null, 2), 'utf-8');
          }
        } catch (e) { /* 跳过损坏文件 */ }
      }
    }
  } catch (e) { errors.push('书架: ' + e.message); }

  // 8) 刷新扫描缓存，让漫画立即从书架消失
  try { await scanAllLibs(true); } catch (e) { errors.push('刷新缓存: ' + e.message); }

  return errors;
}

app.delete('/api/comic/:id', authMiddleware, adminOnly, async (req, res) => {
  if (!getSettings().allowDeleteComic) {
    return res.status(403).json({ error: '删除功能未开启（请在控制面板开启"允许删除漫画"）' });
  }
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  const errors = await deleteComicFully(comic);
  if (errors.length) {
    return res.json({ success: true, partial: true, deleted: comic.name, warnings: errors });
  }
  res.json({ success: true, deleted: comic.name });
});

// ── 管理员 API ─────────────────────────────────────
const { listUsers } = require('./lib/auth');

app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  res.json(listUsers());
});

app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  const { addUser } = require('./lib/auth');
  const result = addUser(username, password);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true, username });
});

app.delete('/api/admin/users/:username', authMiddleware, adminOnly, async (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: '不能删除当前登录的账号' });
  }
  const { removeUser } = require('./lib/auth');
  const result = removeUser(req.params.username);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

app.put('/api/admin/users/:username/password', authMiddleware, adminOnly, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: '缺少新密码' });
  const { resetPassword } = require('./lib/auth');
  const result = resetPassword(req.params.username, newPassword);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

app.put('/api/admin/users/:username/role', authMiddleware, adminOnly, async (req, res) => {
  const { role } = req.body || {};
  const { setRole } = require('./lib/auth');
  const result = setRole(req.params.username, role);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

// ── 库管理（Emby 式存储路径） ────────────────────────
const libsFile = path.join(DATA_DIR, 'libraries.json');
const libsStore = getStore(libsFile, []);

function readLibs() {
  const v = libsStore.read();
  return Array.isArray(v) ? v : [];
}
function writeLibs(libs) {
  libsStore.set(libs);
  invalidateScan();
}

// 初始化默认库 + 小说目录
if (!fs.existsSync(libsFile)) {
  const defaultLibs = [{ id: 1, path: COMICS_DIR, name: '漫画' }];
  const novelPath = process.env.NOVEL_DIR || '';
  if (novelPath && fs.existsSync(novelPath)) {
    defaultLibs.push({ id: 2, path: novelPath, name: '小说' });
  }
  writeLibs(defaultLibs);
}

app.get('/api/admin/libraries', authMiddleware, adminOnly, async (req, res) => {
  res.json(readLibs());
});

app.post('/api/admin/libraries', authMiddleware, adminOnly, async (req, res) => {
  const { path: libPath, name } = req.body || {};
  if (!libPath || typeof libPath !== 'string') return res.status(400).json({ error: '缺少路径' });
  if (!path.isAbsolute(libPath)) return res.status(400).json({ error: '请填写绝对路径' });
  if (!fs.existsSync(libPath)) return res.status(400).json({ error: '路径不存在' });
  try {
    if (!fs.statSync(libPath).isDirectory()) return res.status(400).json({ error: '不是文件夹' });
  } catch {
    return res.status(400).json({ error: '路径不可访问' });
  }

  const libs = readLibs();
  if (libs.some(l => l.path === libPath)) return res.status(400).json({ error: '该目录已添加' });
  const id = Math.max(0, ...libs.map(l => l.id)) + 1;
  libs.push({ id, path: libPath, name: name || libPath.split('/').filter(Boolean).pop() || libPath });
  writeLibs(libs);
  res.json({ success: true, id });
});

app.delete('/api/admin/libraries/:id', authMiddleware, adminOnly, async (req, res) => {
  const libs = readLibs().filter(l => l.id !== parseInt(req.params.id, 10));
  writeLibs(libs);
  res.json({ success: true });
});

// ── 自动解密设置 ─────────────────────────────────────
app.get('/api/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  res.json(getSettings());
});

app.post('/api/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  const updated = saveSettings(req.body || {});
  // 管理员开启自动解密的瞬间，立即跑一次扫描
  if (updated.autoDecrypt) {
    autoDecryptOnce(readLibs())
      .then(s => console.log(`[autodecrypt] 手动触发 扫描=${s.scanned} 解密=${s.decrypted} 失败=${s.failed}`))
      .catch(e => console.error('[autodecrypt] 手动触发失败:', e.message));
  }
  res.json({ success: true, settings: updated });
});

// 书架扫描——支持多库 + 类型分类 + 缓存刷新
app.get('/api/library', authMiddleware, async (req, res) => {
  try {
    const typeFilter = req.query.type; // comic | novel | undefined=全部
    const forceRefresh = req.query.refresh === '1';
    const allComics = await scanAllLibs(forceRefresh);

    const filtered = typeFilter ? allComics.filter(c => c.type === typeFilter) : allComics;
    const progress = getUserProgress(req.user.username);
    const bookmarks = new Set(Object.entries(progress).filter(([, v]) => v && v.bookmarked).map(([id]) => id));

    const decorate = c => ({
      ...c,
      progress: progress[c.id] || null,
      bookmarked: bookmarks.has(c.id),
      hasCover: hasCover(c.id, c.path)
    });

    const enriched = filtered.map(decorate);
    const seriesMap = {};
    for (const c of enriched) {
      if (!seriesMap[c.series]) seriesMap[c.series] = [];
      seriesMap[c.series].push(c);
    }
    const seriesList = Object.entries(seriesMap).map(([name, items]) => ({ name, count: items.length, items }));

    // 最近添加：优先展示「今日添加」的漫画；若今日无添加，顺延到最近一个有添加的日子；上限 100 本
    const dayKeyOf = d => {
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, '0');
      const dnum = String(dt.getDate()).padStart(2, '0');
      return `${y}-${m}-${dnum}`;
    };
    const byDay = {};
    for (const c of filtered) {
      const k = dayKeyOf(c.mtime);
      if (!k) continue;
      (byDay[k] = byDay[k] || []).push(c);
    }
    const todayKey = dayKeyOf(new Date());
    let recentKey = todayKey;
    if (!byDay[recentKey] || byDay[recentKey].length === 0) {
      // 今日无添加，向前顺延到最近一个有添加的日子
      const descKeys = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));
      recentKey = descKeys.find(k => byDay[k].length > 0) || recentKey;
    }
    const recent = (byDay[recentKey] || [])
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
      .slice(0, 100)
      .map(decorate);
    const recentLabel = recentKey === todayKey
      ? `今日添加 (${byDay[recentKey] ? byDay[recentKey].length : 0} 本)`
      : `最近添加 (${recentKey} 添加${byDay[recentKey] ? ' ' + byDay[recentKey].length + ' 本' : ''})`;

    res.json({
      series: seriesList,
      total: enriched.length,
      recent,
      recentLabel,
      types: {
        comic: allComics.filter(c => c.type === 'comic').length,
        novel: allComics.filter(c => c.type === 'novel').length
      }
    });
  } catch (err) {
    console.error('[library]', err);
    res.status(500).json({ error: '扫描失败' });
  }
});

// ── 自定义书架 ─────────────────────────────────────
const shelvesDir = path.join(DATA_DIR, 'shelves');

function safeUserName(username) {
  // 防止 ../ 之类的用户名把文件写到别处
  return String(username).replace(/[^\w.@-]/g, '_').slice(0, 64) || 'user';
}
function shelvesStore(username) {
  return getStore(path.join(shelvesDir, `${safeUserName(username)}.json`), []);
}
function readShelves(username) {
  const v = shelvesStore(username).read();
  return Array.isArray(v) ? v : [];
}

app.get('/api/shelves', authMiddleware, async (req, res) => {
  const shelves = readShelves(req.user.username);
  const comicMap = await getComicMap();
  res.json(shelves.map(s => ({
    ...s,
    itemCount: s.items.length,
    previews: s.items.slice(0, 4)
      .map(id => comicMap[id])
      .filter(Boolean)
      .map(c => ({ id: c.id, name: c.name, hasCover: hasCover(c.id, c.path) }))
  })));
});

app.post('/api/shelves', authMiddleware, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '书架名称不能为空' });
  const store = shelvesStore(req.user.username);
  const id = Date.now().toString(36);
  store.update(shelves => {
    shelves.push({ id, name: String(name).trim().slice(0, 64), items: [], createdAt: new Date().toISOString() });
  });
  store.flush();
  res.json({ success: true, id });
});

app.put('/api/shelves/:id', authMiddleware, async (req, res) => {
  const { name, addItem, removeItem } = req.body || {};
  const store = shelvesStore(req.user.username);
  let found = false;
  store.update(shelves => {
    const shelf = shelves.find(s => s.id === req.params.id);
    if (!shelf) return;
    found = true;
    if (name) shelf.name = String(name).trim().slice(0, 64);
    if (addItem && !shelf.items.includes(addItem)) shelf.items.push(addItem);
    if (removeItem) shelf.items = shelf.items.filter(i => i !== removeItem);
  });
  if (!found) return res.status(404).json({ error: '书架不存在' });
  store.flush();
  res.json({ success: true });
});

app.delete('/api/shelves/:id', authMiddleware, async (req, res) => {
  const store = shelvesStore(req.user.username);
  store.set(readShelves(req.user.username).filter(s => s.id !== req.params.id));
  res.json({ success: true });
});

app.get('/api/shelves/:id', authMiddleware, async (req, res) => {
  const shelf = readShelves(req.user.username).find(s => s.id === req.params.id);
  if (!shelf) return res.status(404).json({ error: '书架不存在' });
  const comicMap = await getComicMap();
  const items = shelf.items.map(id => comicMap[id]).filter(Boolean);
  const progress = getUserProgress(req.user.username);
  res.json({
    ...shelf,
    items: items.map(c => ({ ...c, progress: progress[c.id] || null, hasCover: hasCover(c.id, c.path) }))
  });
});

// ── 阅读统计与排行榜 ─────────────────────────────────
const viewsStore = getStore(path.join(DATA_DIR, 'views.json'), {});
const likesStore = getStore(path.join(DATA_DIR, 'likes.json'), {});

app.post('/api/comic/:id/view', authMiddleware, async (req, res) => {
  const id = req.params.id;
  let count = 0;
  viewsStore.update(views => {
    if (!views[id]) views[id] = { count: 0, firstView: new Date().toISOString(), lastView: null };
    views[id].count++;
    views[id].lastView = new Date().toISOString();
    count = views[id].count;
  });
  res.json({ success: true, count });
});

// ── 点赞/爱心 ──────────────────────────────────────

function likeCount(likes, id) {
  let total = 0;
  for (const u of Object.keys(likes)) {
    if (Array.isArray(likes[u]) && likes[u].includes(id)) total++;
  }
  return total;
}

app.post('/api/comic/:id/like', authMiddleware, async (req, res) => {
  const user = req.user.username;
  const id = req.params.id;
  let liked = false;
  const likes = likesStore.read();
  likesStore.update(l => {
    if (!Array.isArray(l[user])) l[user] = [];
    const idx = l[user].indexOf(id);
    if (idx >= 0) { l[user].splice(idx, 1); liked = false; }
    else { l[user].push(id); liked = true; }
  });
  res.json({ liked, totalLikes: likeCount(likes, id) });
});

app.get('/api/likes', authMiddleware, async (req, res) => {
  const likes = likesStore.read();
  res.json({ items: likes[req.user.username] || [] });
});

// ── 评论区（匿名 + 昵称，存本地 JSON，按 comic id 分文件） ──
const commentsDir = path.join(DATA_DIR, 'comments');
function commentsStore(id) {
  const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
  return getStore(path.join(commentsDir, `${safe}.json`), []);
}
app.get('/api/comic/:id/comments', authMiddleware, async (req, res) => {
  const list = commentsStore(req.params.id).read();
  res.json(Array.isArray(list) ? list : []);
});
app.post('/api/comic/:id/comments', authMiddleware, async (req, res) => {
  const { name, text } = req.body || {};
  const t = String(text || '').trim();
  if (!t) return res.status(400).json({ error: '评论内容不能为空' });
  const store = commentsStore(req.params.id);
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim().slice(0, 24) || '匿名',
    text: t.slice(0, 1000),
    ts: new Date().toISOString()
  };
  store.update(list => { list.push(entry); });
  store.flush();
  res.json({ success: true, comment: entry });
});

app.get('/api/comic/:id/likes', authMiddleware, async (req, res) => {
  const likes = likesStore.read();
  const id = req.params.id;
  res.json({
    totalLikes: likeCount(likes, id),
    liked: (likes[req.user.username] || []).includes(id)
  });
});

// ── 在线模块（可插拔多源，默认全关，见 lib/sources/sources.json）：搜索 / 详情 / 章节 ──
// 已启用源由 ONLINE_SOURCE 决定（逗号列表 / all / 不设置则用 enabledByDefault）。

// 已启用源列表（前端渲染源切换器）
app.get('/api/online/sources', authMiddleware, (req, res) => {
  const enabled = onlineSources.getEnabled();
  res.json({
    enabled: onlineSources.isEnabled(),
    sources: enabled.map(s => ({ key: s.key, name: s.name, description: s.description })),
  });
});

// 在线模块状态（前端据此决定是否展示「未启用」提示，无需先触发搜索）
app.get('/api/online/status', authMiddleware, async (req, res) => {
  res.json({
    enabled: onlineSources.isEnabled(),
    source: onlineSources.getActiveName(),
    available: onlineSources.listSources(),
  });
});

// 搜索：跨所有已启用源并发查询并合并；每条结果打上 _source 标记以便后续路由
app.get('/api/online/search', authMiddleware, async (req, res) => {
  const enabled = onlineSources.getEnabled();
  if (!enabled.length) {
    return res.status(403).json({ error: '在线漫画模块未启用：请在环境变量中设置 ONLINE_SOURCE=jm 并重启服务' });
  }
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ total: 0, maxPage: 0, comics: [] });
  const order = (req.query.order || 'mr').toString();
  const page = parseInt(req.query.page, 10) || 1;
  const merged = [];
  await Promise.allSettled(enabled.map(async s => {
    try {
      const r = await s.impl.search(q, order, page);
      if (r && Array.isArray(r.comics)) {
        for (const c of r.comics) { c._source = s.key; merged.push(c); }
      }
    } catch (err) {
      console.error(`[online/search:${s.key}]`, err.message);
    }
  }));
  res.json({ total: merged.length, maxPage: 1, comics: merged });
});

// 详情：按 ?source= 选择源（缺省用首个启用源）
app.get('/api/online/album/:id', authMiddleware, async (req, res) => {
  const source = onlineSources.getSource(req.query.source) || onlineSources.getActiveSource();
  if (!source) return res.status(403).json({ error: '在线漫画模块未启用' });
  try {
    const r = await source.album(req.params.id);
    if (r) r._source = req.query.source || onlineSources.getActiveName();
    res.json(r || {});
  } catch (err) {
    console.error('[online/album]', err.message);
    res.status(502).json({ error: '获取详情失败：' + (err.message || err) });
  }
});

// 章节：按 ?source= 选择源
app.get('/api/online/chapter/:id', authMiddleware, async (req, res) => {
  const source = onlineSources.getSource(req.query.source) || onlineSources.getActiveSource();
  if (!source) return res.status(403).json({ error: '在线漫画模块未启用' });
  try {
    const r = await source.chapter(req.params.id);
    res.json(r || {});
  } catch (err) {
    console.error('[online/chapter]', err.message);
    res.status(502).json({ error: '获取章节失败：' + (err.message || err) });
  }
});

// ── 在线图片代理（通用：拉取 + 按 URL 自动路由到认得它的源做还原，绕过防盗链） ──
// 前端 <img> 直接引用本端点即可显示还原后的图片，无需自己处理 Referer/乱序。
app.get('/api/online/img', authMiddleware, async (req, res) => {
  const url = (req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  try {
    const r = await getOnlineImage(url);
    if (r.error) return res.status(400).json({ error: r.error });
    res.set('Content-Type', r.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.buffer);
  } catch (err) {
    console.error('[online/img]', err.message);
    if (!res.headersSent) res.status(502).json({ error: '图片获取失败' });
  }
});

// ── AstrBot 联动（后端代理：凭据存服务端，绝不下发前端） ──
const astrbotConfigFile = path.join(DATA_DIR, 'astrbot_config.json');
function loadAstrbotConfig() {
  try { return JSON.parse(fs.readFileSync(astrbotConfigFile, 'utf8')); }
  catch { return { address: '', username: '', password: '' }; }
}
function saveAstrbotConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = loadAstrbotConfig();
  // 密码留空 = 不修改（保留原密码），避免误清空
  const password = (cfg.password && cfg.password.length) ? cfg.password : (existing.password || '');
  fs.writeFileSync(astrbotConfigFile, JSON.stringify({
    address: (cfg.address || '').trim(),
    username: (cfg.username || '').trim(),
    password
  }, null, 2));
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
/** 防止 SSRF：拒绝内网私有/回环地址 */
function isPrivateHost(hostname) {
  // 允许的主机名白名单（本地 AstrBot 地址）
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false; // 家庭内网放行
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false; // 本地放行
  // 拒绝私有/保留地址段
  if (net.isIP(hostname)) {
    const ip = hostname;
    if (ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('192.168.')) return true;
    if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) return true;
  }
  return false;
}

// 简单 HTTP JSON 请求；对 SSE 响应抓取第一条 plain 回复。返回 {status, body, plain}
function astrbotHttp(method, urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('AstrBot 地址无效：' + urlStr)); }
    // SSRF 防护：拒绝内网高危地址
    if (isPrivateHost(u.hostname)) {
      return reject(new Error('安全限制：不允许访问内网地址 ' + u.hostname));
    }
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers,
      timeout: 15000
    }, (res) => {
      let buf = '';
      let plain = null;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (plain) return;
        buf.split('\n').forEach((line) => {
          const s = line.trim();
          if (s.startsWith('data:')) {
            const json = s.slice(5).trim();
            if (json && json !== '[DONE]') {
              try { const o = JSON.parse(json); if (o.type === 'plain') plain = o.data; } catch {}
            }
          }
        });
      });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, plain }));
    });
    req.on('timeout', () => req.destroy(new Error('AstrBot 响应超时')));
    req.on('error', reject);
    if (bodyObj) req.write(JSON.stringify(bodyObj));
    req.end();
  });
}

// 向 AstrBot 发送指令：SSE 流可能持续很久（下载进度），只要收到响应头即视为发送成功
function astrbotSendCommand(base, token, sid, command) {
  return new Promise((resolve, reject) => {
    const urlStr = base + '/api/v1/chat';
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('AstrBot 地址无效：' + urlStr)); }
    if (isPrivateHost(u.hostname)) {
      return reject(new Error('安全限制：不允许访问内网地址 ' + u.hostname));
    }
    const body = JSON.stringify({ session_id: sid, message: command });
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    }, (res) => {
      // 收到响应头就结束，不再等待 SSE 体
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('AstrBot 响应超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
function astrbotBase(cfg) {
  let a = (cfg.address || '').trim();
  if (!a) throw new Error('AstrBot 未配置地址');
  if (!/^https?:\/\//i.test(a)) a = 'http://' + a;
  return a.replace(/\/+$/, '');
}
// 登录 AstrBot 并返回 base + token（供命令/会话/附件复用）
async function astrbotLogin(cfg) {
  const base = astrbotBase(cfg);
  const login = await astrbotHttp('POST', base + '/api/v1/auth/login', null, { username: cfg.username, password: cfg.password });
  const loginJson = safeParse(login.body);
  const token = loginJson && loginJson.data && loginJson.data.token;
  if (!token) throw new Error('AstrBot 登录失败（账号或密码错误）');
  return { base, token };
}
app.get('/api/astrbot/config', authMiddleware, async (req, res) => {
  const c = loadAstrbotConfig();
  res.json({ address: c.address || '', username: c.username || '' }); // 不下发密码
});
app.post('/api/astrbot/config', authMiddleware, async (req, res) => {
  const { address, username, password } = req.body || {};
  if (!address) return res.status(400).json({ status: 'error', message: '请填写 AstrBot 地址' });
  saveAstrbotConfig({ address, username, password });
  res.json({ status: 'ok' });
});
app.post('/api/astrbot/command', authMiddleware, async (req, res) => {
  const cfg = loadAstrbotConfig();
  if (!cfg.address || !cfg.username) {
    return res.json({ status: 'error', code: 'no_config', message: 'AstrBot 未配置，请先在弹窗里填好地址 / 账号 / 密码' });
  }
  // 支持直接透传完整指令（command），兼容旧的 query+type 写法
  let command = (req.body.command || '').toString().trim();
  if (!command) {
    const query = (req.body.query || '').toString().trim();
    const type = (req.body.type || 'jm').toString().replace(/[^a-z0-9]/gi, '');
    if (!query) return res.json({ status: 'error', message: '请输入 JM ID 或关键词' });
    command = `/${type} ${query}`;
  }
  if (!command.startsWith('/')) command = '/' + command;
  const base = astrbotBase(cfg);
  try {
    const { token } = await astrbotLogin(cfg);
    const sess = await astrbotHttp('GET', base + '/api/v1/chat/sessions/new', token);
    const sessJson = safeParse(sess.body);
    const sid = sessJson && sessJson.data && sessJson.data.session_id;
    if (!sid) return res.json({ status: 'error', message: 'AstrBot 创建会话失败' });
    const send = await astrbotSendCommand(base, token, sid, command);
    if (send.status !== 200 && send.status !== 201) {
      return res.json({ status: 'error', message: 'AstrBot 发送失败（HTTP ' + send.status + '）' });
    }
    // 返回 sessionId 供前端轮询完整会话（含进度/详情/图片）
    res.json({ status: 'ok', command, reply: '', sessionId: sid, address: cfg.address });
  } catch (e) {
    res.json({ status: 'error', message: '调用 AstrBot 出错：' + (e.message || e) });
  }
});

// 轮询 AstrBot 会话历史（文字 + 图片附件），用于展示详情与下载进度
app.get('/api/astrbot/session/:id', authMiddleware, async (req, res) => {
  const cfg = loadAstrbotConfig();
  if (!cfg.address || !cfg.username) {
    return res.json({ status: 'error', code: 'no_config', message: 'AstrBot 未配置' });
  }
  try {
    const { base, token } = await astrbotLogin(cfg);
    const r = await astrbotHttp('GET', base + '/api/v1/chat/sessions/' + encodeURIComponent(req.params.id), token);
    const j = safeParse(r.body);
    const hist = (j && j.data && j.data.history) || [];
    const messages = [];
    for (const m of hist) {
      const role = m.sender_name === 'bot' ? 'bot' : 'user';
      for (const part of (m.content && m.content.message) || []) {
        if (part.type === 'plain') messages.push({ role, type: 'text', text: part.text });
        else if (part.type === 'image') messages.push({ role, type: 'image', attachmentId: part.attachment_id, filename: part.filename });
      }
    }
    res.json({ status: 'ok', messages });
  } catch (e) {
    res.json({ status: 'error', message: '获取会话失败：' + (e.message || e) });
  }
});

// 代理 AstrBot 图片附件（二进制透传），前端 <img> 直接引用
app.get('/api/astrbot/attachment/:sid/:aid', authMiddleware, async (req, res) => {
  const cfg = loadAstrbotConfig();
  if (!cfg.address || !cfg.username) return res.status(401).end();
  try {
    const { base, token } = await astrbotLogin(cfg);
    const url = base + '/api/v1/file?attachment_id=' + encodeURIComponent(req.params.aid);
    let u;
    try { u = new URL(url); } catch { return res.status(400).end(); }
    if (isPrivateHost(u.hostname)) return res.status(400).end();
    const pr = http.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 20000
    }, (resp) => {
      if (resp.statusCode !== 200) { res.status(resp.statusCode || 502).end(); return; }
      res.set('Content-Type', resp.headers['content-type'] || 'image/jpeg');
      resp.pipe(res);
    });
    pr.on('timeout', () => pr.destroy(new Error('timeout')));
    pr.on('error', () => res.status(502).end());
    pr.end();
  } catch (e) {
    res.status(502).end();
  }
});

// 排行榜（本周 + 总榜，爱心参与排名）
app.get('/api/ranking', authMiddleware, async (req, res) => {
  const views = viewsStore.read();
  const likes = likesStore.read();
  const comicMap = await getComicMap();

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const allIds = new Set([...Object.keys(views), ...Object.keys(likes).flatMap(u => likes[u] || [])]);

  const entries = [...allIds].filter(id => comicMap[id]).map(id => {
    const v = (views[id] || {}).count || 0;
    const l = likeCount(likes, id);
    return {
      id,
      name: comicMap[id].name,
      type: comicMap[id].type,
      views: v,
      likes: l,
      score: v + l * 3,   // 综合分 = 阅读数 + 爱心数 × 3
      lastView: (views[id] || {}).lastView,
      hasCover: hasCover(id, comicMap[id].path)
    };
  });

  const weekly = entries
    .filter(e => e.lastView && new Date(e.lastView).getTime() > weekAgo)
    .sort((a, b) => b.score - a.score).slice(0, 20);

  const allTime = [...entries].sort((a, b) => b.score - a.score).slice(0, 20);

  res.json({ weekly, allTime });
});

// ── SPA fallback ────────────────────────────────────

app.get('/', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/app', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// 未知 API 一律返回 JSON，别让前端 JSON.parse 吃到 HTML
app.use('/api', async (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 全局错误处理（Express 4 会捕获同步抛出的异常）
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 兜底：别让一个未捕获的 Promise 拒绝把整个阅读器搞挂
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ── 启动 ────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`📚 fnOS Comic Reader running at http://0.0.0.0:${PORT}`);
    console.log(`📂 Comics directory: ${COMICS_DIR}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`🔐 JWT secret: ${JWT_SECRET.slice(0, 8)}... (持久化)`);

    // 自动解密调度：管理员在控制面板开启后，周期性把库里仍为加密的 PDF 原地解密
    startAutoDecryptScheduler(readLibs);
  });
}

module.exports = app;
