// Express server: auth, library scan/cache, PDF/EPUB/CBZ/cover serving, bookmarks, annotations, admin API.

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
  removeComicFromAllUsers,
  readAll: readAllProgress,
  PROGRESS_FILE
} = require('./lib/progress');
const { getImageList, extractImage } = require('./lib/cbz');
const { generate, prewarm, get: getCover, hasCover, saveCover } = require('./lib/thumbnail');
const { getToc, getChapter, getResource } = require('./lib/epub');
const { getStore, installExitHooks } = require('./lib/jsonstore');
const { getSettings, saveSettings } = require('./lib/settings');
const { autoDecryptOnce, startAutoDecryptScheduler } = require('./lib/autodecrypt');
const { isEncryptedPdf, decryptPdfBuffer, decryptFileInPlace } = require('./lib/decrypt');
const { getOnlineImage } = require('./lib/online-image');
const { startDownload, getJob, publicJob, listHistory } = require('./lib/onlinedl');
const audit = require('./lib/auditlog');
const onlineSources = require('./lib/sources');

const app = express();

// Express 4 does not catch rejections from async handlers; without this wrapper the client hangs forever.
for (const verb of ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'use']) {
  const original = app[verb].bind(app);
  app[verb] = (...args) => original(...args.map(h => (
    (typeof h === 'function' && h.constructor && h.constructor.name === 'AsyncFunction')
      ? (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      : h
  )));
}

const PORT = process.env.PORT || 3000;
const COMICS_DIR = process.env.COMICS_DIR || '/comics';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

installExitHooks();

audit.init().catch(e => console.error('[audit] init 失败:', e.message));

function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt-secret');
  try {
    const s = fs.readFileSync(f, 'utf-8').trim();
    if (s.length >= 32) return s;
  } catch {  }
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

app.use(express.json({ limit: '1mb' }));
app.use(require('compression')());
app.use('/api/comic/:id/cover', express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' }));

app.disable('x-powered-by');

app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false, setHeaders: res => { res.set('Cache-Control', 'no-cache'); } }));
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false, setHeaders: res => { res.set('Cache-Control', 'no-cache'); } }));
// express@4's send uses mime@1.6, which does not know .mjs, so the type must be set or browsers refuse it.
app.use('/vendor', express.static(path.join(PUBLIC_DIR, 'vendor'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs')) res.set('Content-Type', 'text/javascript; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=604800');
  }
}));
app.use(express.static(PUBLIC_DIR, { index: false }));

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

// Login rate limit: 10 failures per IP+account in 5 minutes.
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
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now - v.first > LOGIN_WINDOW) loginAttempts.delete(k);
}, LOGIN_WINDOW).unref();

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = audit.clientIp(req);
  if (!username || !password) {
    audit.record({ user: username || '-', ip, action: 'login', detail: '缺少用户名或密码', result: 'fail' });
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const key = loginKey(req, username);
  if (isLocked(key)) {
    audit.record({ user: username, ip, action: 'login', detail: '触发限速已锁定', result: 'blocked' });
    return res.status(429).json({ error: '登录尝试过于频繁，请 5 分钟后再试' });
  }

  const result = await authenticate(username, password);
  if (!result.success) {
    noteFail(key);
    audit.record({ user: username, ip, action: 'login', detail: result.error || '密码错误', result: 'fail' });
    return res.status(401).json({ error: result.error || '登录失败' });
  }
  loginAttempts.delete(key);

  const token = jwt.sign(
    { username: result.username, role: result.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  audit.record({ user: result.username, ip, action: 'login', detail: `角色 ${result.role}`, result: 'ok' });
  res.json({ token, user: { username: result.username, role: result.role } });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  res.json({ user: { username: req.user.username, role: req.user.role } });
});

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
  // Prefer the sidecar-declared type over extension sniffing, so a PDF in the novel library stays a novel.
  for (const c of all) {
    c.type = (c.metaType === 'novel' || c.metaType === 'comic')
      ? c.metaType
      : (['pdf', 'cbz', 'cbr'].includes(c.ext) ? 'comic' : 'novel');
  }

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

app.get('/api/continue', authMiddleware, async (req, res) => {
  const items = getContinueReading(req.user.username);
  const comicMap = await getComicMap();

  // Keep records whose comic is no longer in the scan: dropping them silently made
  // reading history disappear whenever a file was deleted or renamed outside the app.
  const result = items
    .map(item => {
      const comic = comicMap[item.id];
      if (!comic) {
        return { id: item.id, name: item.name || '已删除的漫画', missing: true, progress: item, hasCover: false };
      }
      return { ...comic, progress: item, hasCover: hasCover(item.id, comic.path) };
    });

  res.json(result);
});

app.get('/api/bookmarks', authMiddleware, async (req, res) => {
  const items = getBookmarks(req.user.username);
  const comicMap = await getComicMap();

  // Same as /api/continue: a bookmark must not vanish because the file was removed elsewhere.
  const result = items
    .map(item => {
      const comic = comicMap[item.id];
      if (!comic) {
        return { id: item.id, name: item.name || '已删除的漫画', missing: true, progress: { page: 0, bookmarked: true }, hasCover: false };
      }
      return { ...comic, progress: { page: 0, bookmarked: true }, hasCover: hasCover(item.id, comic.path) };
    });

  res.json(result);
});

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
      pageCount = (await getImageList(comic.path)).length;
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

app.get('/api/comic/:id/file', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (comic.ext !== 'pdf') return res.status(400).json({ error: '非 PDF 格式' });

  const filePath = comic.path;
  let stat, fileSize;
  try { stat = fs.statSync(filePath); fileSize = stat.size; }
  catch { return res.status(404).json({ error: '文件已不存在，请刷新书架' }); }

  // Files are decrypted when they enter the library; never decrypt a whole file inside the request path.

  const range = req.headers.range;
  // Range must be validated: "bytes=abc-" parses to NaN and kills the connection.
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? NaN : parseInt(m[1], 10);
    let end = m[2] === '' ? NaN : parseInt(m[2], 10);

    if (Number.isNaN(start) && Number.isNaN(end)) {
      return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    }
    if (Number.isNaN(start)) { // "bytes=-500" means the last 500 bytes.
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

app.get('/api/comic/:id/page/:pageNum', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  if (!['cbz', 'cbr'].includes(comic.ext)) {
    return res.status(400).json({ error: '非 CBZ/CBR 格式' });
  }

  try {
    const images = await getImageList(comic.path);
    const pageNum = parseInt(req.params.pageNum, 10);
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > images.length) {
      return res.status(404).json({ error: '页码不存在' });
    }

    const entryName = images[pageNum - 1];
    const buffer = await extractImage(comic.path, entryName);
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

app.get('/api/comic/:id/cover', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });

  try {
    const coverPath = await generate(comic.path, comic.id);
    if (coverPath && fs.existsSync(coverPath)) {
      // res.sendFile handles content-type, ETag/304 and Range for us.
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

  res.status(404).end();
});

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

app.post('/api/comic/:id/progress', authMiddleware, async (req, res) => {
  const { page, totalPages } = req.body || {};
  if (page === undefined) return res.status(400).json({ error: '缺少 page 参数' });
  const pageNum = Number(page);
  if (!Number.isFinite(pageNum) || pageNum < 0) {
    return res.status(400).json({ error: 'page 参数无效' });
  }

  const comic = await findComic(req.params.id);
  if (!comic) { return res.status(404).json({ error: '漫画不存在' }); }

  const result = saveProgress(req.user.username, req.params.id, pageNum, Number(totalPages) || 0, comic.name);
  res.json(result);
});

app.post('/api/comic/:id/bookmark', authMiddleware, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) { return res.status(404).json({ error: '漫画不存在' }); }
  const result = toggleBookmark(req.user.username, req.params.id, comic.name);
  res.json(result);
});

// Reports which users hold progress / bookmarks / likes / comments / shelf entries for a comic.
// Its purpose is to warn before a delete, not to enforce anything.
function impactOfDeletion(comicId, opts = {}) {
  const exclude = new Set(opts.excludeUsers || []);
  const affected = [];

  try {
    const all = readAllProgress();
    for (const [user, entries] of Object.entries(all)) {
      if (exclude.has(user)) continue;
      const entry = entries && entries[comicId];
      if (!entry) continue;
      if (entry.bookmarked || (entry.page > 0)) {
        affected.push({ user, bookmarked: !!entry.bookmarked, page: entry.page || 0, name: entry.name || '' });
      }
    }
  } catch (e) { }

  let likes = 0;
  try {
    const all = likesStore.read();
    for (const v of Object.values(all || {})) {
      if (Array.isArray(v) ? v.includes(comicId) : (v === comicId)) likes++;
    }
  } catch (e) { }

  let shelfCount = 0;
  try {
    if (fs.existsSync(shelvesDir)) {
      for (const f of fs.readdirSync(shelvesDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const shelves = JSON.parse(fs.readFileSync(path.join(shelvesDir, f), 'utf-8'));
          if (Array.isArray(shelves)) shelfCount += shelves.filter(s => s.items && s.items.includes(comicId)).length;
        } catch (e) { }
      }
    }
  } catch (e) { }

  let comments = 0;
  try {
    const safe = String(comicId).replace(/[^\w.-]/g, '_').slice(0, 128);
    const fp = path.join(commentsDir, `${safe}.json`);
    if (fs.existsSync(fp)) {
      const list = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      comments = Array.isArray(list) ? list.length : 0;
    }
  } catch (e) { }

  return {
    users: affected.sort((a, b) => (b.bookmarked ? 1 : 0) - (a.bookmarked ? 1 : 0)),
    likes, shelfCount, comments
  };
}

// Collects progress / bookmark records whose comic is no longer in the scan.
// Files deleted outside the app never reach the delete route, so those records are orphaned.
async function collectOrphans() {
  const comicMap = await getComicMap();
  const all = readAllProgress();
  const entries = [];

  for (const [user, records] of Object.entries(all || {})) {
    for (const [id, v] of Object.entries(records || {})) {
      if (comicMap[id]) continue;
      entries.push({
        user,
        id,
        name: (v && v.name) || '',
        bookmarked: !!(v && v.bookmarked),
        page: (v && v.page) || 0,
        updatedAt: (v && v.updatedAt) || ''
      });
    }
  }

  entries.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return entries;
}

async function deleteComicFully(comic) {
  const id = comic.id;
  const errors = [];

  try {
    await fs.promises.rm(comic.path, { recursive: true, force: true });
  } catch (e) { errors.push('本体: ' + e.message); }

  const primaryCover = path.join(path.dirname(comic.path), '.thumbnails', `${id}.jpg`);
  const fallbackCover = path.join(DATA_DIR, 'thumbnails', `${id}.jpg`);
  for (const f of [primaryCover, fallbackCover]) {
    try { await fs.promises.rm(f, { force: true }); } catch (e) {  }
  }

  try { removeComicFromAllUsers(id); } catch (e) { errors.push('进度: ' + e.message); }

  try { viewsStore.update(v => { delete v[id]; }); } catch (e) { errors.push('浏览: ' + e.message); }

  try { likesStore.update(l => { delete l[id]; }); } catch (e) { errors.push('点赞: ' + e.message); }

  try {
    const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
    await fs.promises.rm(path.join(commentsDir, `${safe}.json`), { force: true });
  } catch (e) {  }

  try {
    const safeA = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
    await fs.promises.rm(path.join(annotationsDir, `${safeA}.json`), { force: true });
  } catch (e) {  }

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
            getStore(fp, []).set(next);
          }
        } catch (e) {  }
      }
    }
  } catch (e) { errors.push('书架: ' + e.message); }

  try { await scanAllLibs(true); } catch (e) { errors.push('刷新缓存: ' + e.message); }

  return errors;
}

app.get('/api/comic/:id/impact', authMiddleware, adminOnly, async (req, res) => {
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  res.json(impactOfDeletion(req.params.id));
});

app.delete('/api/comic/:id', authMiddleware, adminOnly, async (req, res) => {
  if (!getSettings().allowDeleteComic) {
    return res.status(403).json({ error: '删除功能未开启（请在控制面板开启"允许删除漫画"）' });
  }
  const comic = await findComic(req.params.id);
  if (!comic) return res.status(404).json({ error: '漫画不存在' });
  // The comic itself is already gone from the scan at this point, so count only the
  // other users whose metadata this delete will affect.
  const impact = impactOfDeletion(req.params.id, { excludeUsers: [req.user.username] });
  const errors = await deleteComicFully(comic);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'delete-comic',
    detail: comic.name + (errors.length ? ' | 部分失败: ' + errors.join('; ') : ''),
    result: errors.length ? 'partial' : 'ok',
  });
  if (errors.length) {
    return res.json({ success: true, partial: true, deleted: comic.name, impact, warnings: errors });
  }
  res.json({ success: true, deleted: comic.name, impact });
});

const { listUsers } = require('./lib/auth');

app.get('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  res.json(listUsers());
});

app.get('/api/admin/audit', authMiddleware, adminOnly, async (req, res) => {
  const data = await audit.query({
    limit: req.query.limit,
    offset: req.query.offset,
    user: req.query.user,
    action: req.query.action,
    result: req.query.result,
  });
  res.json({ ...data, actions: audit.actions() });
});

app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '缺少用户名或密码' });
  const { addUser } = require('./lib/auth');
  const result = addUser(username, password);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'add-user',
    detail: `新增用户 ${username}` + (result.success ? '' : ` | 失败: ${result.error}`),
    result: result.success ? 'ok' : 'fail',
  });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true, username });
});

app.delete('/api/admin/users/:username', authMiddleware, adminOnly, async (req, res) => {
  if (req.params.username === req.user.username) {
    return res.status(400).json({ error: '不能删除当前登录的账号' });
  }
  const { removeUser } = require('./lib/auth');
  const result = removeUser(req.params.username);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'remove-user',
    detail: `删除用户 ${req.params.username}` + (result.success ? '' : ` | 失败: ${result.error}`),
    result: result.success ? 'ok' : 'fail',
  });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

app.put('/api/admin/users/:username/password', authMiddleware, adminOnly, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: '缺少新密码' });
  const { resetPassword } = require('./lib/auth');
  const result = resetPassword(req.params.username, newPassword);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'reset-password',
    detail: `重置 ${req.params.username} 的密码` + (result.success ? '' : ` | 失败: ${result.error}`),
    result: result.success ? 'ok' : 'fail',
  });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

app.get('/api/admin/orphans', authMiddleware, adminOnly, async (req, res) => {
  const entries = await collectOrphans();
  res.json({ entries, total: entries.length });
});

app.post('/api/admin/orphans/clean', authMiddleware, adminOnly, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter(x => typeof x === 'string') : null;
  const targets = ids
    ? new Set(ids)
    : new Set((await collectOrphans()).map(e => e.id));
  if (targets.size === 0) return res.json({ success: true, removed: 0 });

  let removed = 0;
  const progressStore = getStore(PROGRESS_FILE, {});
  progressStore.update(all => {
    for (const [user, records] of Object.entries(all || {})) {
      for (const id of Object.keys(records || {})) {
        if (targets.has(id)) { delete records[id]; removed++; }
      }
      if (records && Object.keys(records).length === 0) delete all[user];
    }
  });
  progressStore.flush();

  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'clean-orphans',
    detail: `清理 ${removed} 条失效记录（${targets.size} 个 id）`,
    result: 'ok',
  });
  res.json({ success: true, removed });
});

app.put('/api/admin/users/:username/role', authMiddleware, adminOnly, async (req, res) => {
  const { role } = req.body || {};
  const { setRole } = require('./lib/auth');
  const result = setRole(req.params.username, role);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'set-role',
    detail: `将 ${req.params.username} 角色改为 ${role}` + (result.success ? '' : ` | 失败: ${result.error}`),
    result: result.success ? 'ok' : 'fail',
  });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

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
  audit.record({ user: req.user.username, ip: audit.clientIp(req), action: 'add-library', detail: libPath, result: 'ok' });
  res.json({ success: true, id });
});

app.delete('/api/admin/libraries/:id', authMiddleware, adminOnly, async (req, res) => {
  const removed = readLibs().find(l => l.id === parseInt(req.params.id, 10));
  const libs = readLibs().filter(l => l.id !== parseInt(req.params.id, 10));
  writeLibs(libs);
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'remove-library',
    detail: removed ? `${removed.name} (${removed.path})` : `id=${req.params.id}`, result: 'ok',
  });
  res.json({ success: true });
});

// The decrypt password is never sent back to the browser; the client only learns whether one is set.
function publicSettings() {
  const s = getSettings();
  return {
    autoDecrypt: !!s.autoDecrypt,
    allowDeleteComic: !!s.allowDeleteComic,
    hasDecryptPassword: !!s.decryptPassword,
  };
}

app.get('/api/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  res.json(publicSettings());
});

app.post('/api/admin/settings', authMiddleware, adminOnly, async (req, res) => {
  const updated = saveSettings(req.body || {});
  if (updated.autoDecrypt) {
    autoDecryptOnce(readLibs())
      .then(s => console.log(`[autodecrypt] 手动触发 扫描=${s.scanned} 解密=${s.decrypted} 失败=${s.failed}`))
      .catch(e => console.error('[autodecrypt] 手动触发失败:', e.message));
  }
  const auditDetail = Object.assign({}, req.body || {});
  if ('decryptPassword' in auditDetail) {
    auditDetail.decryptPassword = auditDetail.decryptPassword ? '***' : '';
  }
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'update-settings',
    detail: JSON.stringify(auditDetail).slice(0, 300), result: 'ok',
  });
  res.json({ success: true, settings: publicSettings() });
});

app.get('/api/library', authMiddleware, async (req, res) => {
  try {
    const typeFilter = req.query.type;
    const forceRefresh = req.query.refresh === '1';
    const allComics = await scanAllLibs(forceRefresh);

    const progress = getUserProgress(req.user.username);

    const progHash = crypto.createHash('md5').update(JSON.stringify(progress)).digest('hex').slice(0, 10);
    // Hash the username: non-ASCII names cannot go into a header value, and this keeps the cache key per user.
    const userKey = crypto.createHash('sha1').update(req.user.username).digest('hex').slice(0, 8);
    const etag = `W/"lib-${_scanTime}-${userKey}-${typeFilter || 'all'}-${allComics.length}-${progHash}"`;
    res.set('Cache-Control', 'no-cache'); // The cache bucket is per user, so switching accounts cannot reuse it.
    res.set('Vary', 'Authorization');
    res.set('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const filtered = typeFilter ? allComics.filter(c => c.type === typeFilter) : allComics;
    const bookmarks = new Set(Object.entries(progress).filter(([, v]) => v && v.bookmarked).map(([id]) => id));

    const decorate = c => ({
      id: c.id,
      name: c.name,
      ext: c.ext,
      series: c.series,
      type: c.type,
      tags: c.tags || [],
      authors: c.authors || [],
      source: c.source || '',
      sourceId: c.sourceId || '',
      size: c.size,
      pageCount: c.pageCount,
      mtime: c.mtime,
      isTranslated: !!c.isTranslated,
      hasCover: hasCover(c.id, c.path),
      progress: progress[c.id] || null,
      bookmarked: bookmarks.has(c.id)
    });

    const enriched = filtered.map(decorate);
    const seriesMap = {};
    for (const c of enriched) {
      if (!seriesMap[c.series]) seriesMap[c.series] = [];
      seriesMap[c.series].push(c);
    }
    const seriesList = Object.entries(seriesMap).map(([name, items]) => ({ name, count: items.length, items }));

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

const shelvesDir = path.join(DATA_DIR, 'shelves');

function safeUserName(username) {
  // Reject "../" in usernames, otherwise the file lands outside the data dir.
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

// Anchor = chapter index + original text + occurrence count.
const annotationsDir = path.join(DATA_DIR, 'annotations');
const ANNOT_COLORS = ['yellow', 'green', 'blue', 'pink'];
function annotationsStore(id) {
  const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
  return getStore(path.join(annotationsDir, `${safe}.json`), []);
}
app.get('/api/comic/:id/annotations', authMiddleware, async (req, res) => {
  const list = annotationsStore(req.params.id).read();
  res.json(Array.isArray(list) ? list : []);
});
app.post('/api/comic/:id/annotations', authMiddleware, async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (!text) return res.status(400).json({ error: '批注原文不能为空' });
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    chapter: parseInt(b.chapter, 10) || 0,
    text: text.slice(0, 2000),
    note: String(b.note || '').trim().slice(0, 2000),
    color: ANNOT_COLORS.includes(b.color) ? b.color : 'yellow',
    occur: parseInt(b.occur, 10) || 0,
    prefix: String(b.prefix || '').slice(0, 40),
    suffix: String(b.suffix || '').slice(0, 40),
    user: req.user.username,
    ts: new Date().toISOString()
  };
  const store = annotationsStore(req.params.id);
  store.update(list => { list.push(entry); });
  store.flush();
  res.json({ success: true, annotation: entry });
});
app.patch('/api/comic/:id/annotations/:aid', authMiddleware, async (req, res) => {
  const store = annotationsStore(req.params.id);
  let hit = null;
  store.update(list => {
    const it = list.find(a => a.id === req.params.aid);
    if (it) {
      if (typeof req.body.note === 'string') it.note = req.body.note.slice(0, 2000);
      if (ANNOT_COLORS.includes(req.body.color)) it.color = req.body.color;
      it.updatedAt = new Date().toISOString();
      hit = it;
    }
  });
  store.flush();
  if (!hit) return res.status(404).json({ error: '批注不存在' });
  res.json({ success: true, annotation: hit });
});
app.delete('/api/comic/:id/annotations/:aid', authMiddleware, async (req, res) => {
  const store = annotationsStore(req.params.id);
  const before = store.read().length;
  store.set(store.read().filter(a => a.id !== req.params.aid));
  res.json({ success: store.read().length < before });
});

// { [chapterIndex]: { title, framework, concepts, statutes, qa, tips } }
const summariesDir = path.join(DATA_DIR, 'summaries');
function summariesStore(id) {
  const safe = String(id).replace(/[^\w.-]/g, '_').slice(0, 128);
  return getStore(path.join(summariesDir, `${safe}.json`), {});
}
app.get('/api/comic/:id/summary', authMiddleware, async (req, res) => {
  const all = summariesStore(req.params.id).read();
  res.json(all && typeof all === 'object' ? all : {});
});
app.get('/api/comic/:id/summary/:chapter', authMiddleware, async (req, res) => {
  const all = summariesStore(req.params.id).read() || {};
  const one = all[String(req.params.chapter)];
  if (!one) return res.status(404).json({ error: '本章暂无 AI 总结' });
  res.json(one);
});
app.put('/api/comic/:id/summary/:chapter', authMiddleware, adminOnly, async (req, res) => {
  const store = summariesStore(req.params.id);
  const key = String(req.params.chapter);
  store.update(obj => { obj[key] = req.body; });
  store.flush();
  res.json({ success: true });
});

app.get('/api/comic/:id/likes', authMiddleware, async (req, res) => {
  const likes = likesStore.read();
  const id = req.params.id;
  res.json({
    totalLikes: likeCount(likes, id),
    liked: (likes[req.user.username] || []).includes(id)
  });
});

app.get('/api/online/sources', authMiddleware, (req, res) => {
  const enabled = onlineSources.getEnabled();
  res.json({
    enabled: onlineSources.isEnabled(),
    sources: enabled.map(s => ({ key: s.key, name: s.name, description: s.description })),
  });
});

app.get('/api/online/status', authMiddleware, async (req, res) => {
  res.json({
    enabled: onlineSources.isEnabled(),
    source: onlineSources.getActiveName(),
    available: onlineSources.listSources(),
  });
});

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
  const maxPages = [];
  await Promise.allSettled(enabled.map(async s => {
    try {
      const r = await s.impl.search(q, order, page);
      if (r && Array.isArray(r.comics)) {
        for (const c of r.comics) { c._source = s.key; merged.push(c); }
        if (r.maxPage) maxPages.push(r.maxPage);
      }
    } catch (err) {
      console.error(`[online/search:${s.key}]`, err.message);
    }
  }));
  res.json({ total: merged.length, maxPage: Math.max(1, ...maxPages), comics: merged });
});

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

const ONLINE_DL_DIR = process.env.ONLINE_DOWNLOAD_DIR || COMICS_DIR;
const ONLINE_DL_MAX_EPISODES = 200;

app.post('/api/online/download', authMiddleware, async (req, res) => {
  const body = req.body || {};
  const srcKey = String(body.source || '').trim();
  const source = onlineSources.getSource(srcKey) || onlineSources.getActiveSource();
  if (!source) return res.status(403).json({ error: '在线漫画模块未启用' });

  const rawEps = Array.isArray(body.episodes) ? body.episodes : [];
  const episodes = rawEps
    .map(e => ({
      id: String((e && e.id) || '').trim(),
      title: String((e && e.title) || '').trim(),
    }))
    .filter(e => e.id);
  if (!episodes.length) return res.status(400).json({ error: '缺少 episodes（待下载章节列表）' });
  if (episodes.length > ONLINE_DL_MAX_EPISODES) {
    return res.status(400).json({ error: `一次最多下载 ${ONLINE_DL_MAX_EPISODES} 个章节` });
  }

  const albumTitle = String(body.albumTitle || '').trim() || episodes[0].title || episodes[0].id;

  const started = startDownload({
    source,
    episodes,
    albumTitle,
    sourceKey: srcKey || onlineSources.getActiveName() || '',
    sourceId: String(body.sourceId || '').trim(),
    authors: Array.isArray(body.authors) ? body.authors.slice(0, 10).map(String) : [],
    tags: Array.isArray(body.tags) ? body.tags.slice(0, 30).map(String) : [],
    targetDir: ONLINE_DL_DIR,
    user: req.user.username,
    ip: audit.clientIp(req),
  });
  if (started.error) {
    audit.record({
      user: req.user.username, ip: audit.clientIp(req), action: 'online-download',
      detail: `${albumTitle} × ${episodes.length} 话 | 失败: ${started.error}`, result: 'fail',
    });
    return res.status(429).json({ error: started.error });
  }
  audit.record({
    user: req.user.username, ip: audit.clientIp(req), action: 'online-download',
    detail: `${albumTitle} × ${episodes.length} 话（${srcKey || onlineSources.getActiveName() || 'source'}）`,
    result: 'ok',
  });
  res.json({ ok: true, jobId: started.job.id, targetDir: ONLINE_DL_DIR });
});

// Must be registered before /:jobId, otherwise that route swallows it.
app.get('/api/online/downloads', authMiddleware, (req, res) => {
  res.json(listHistory({ limit: req.query.limit, offset: req.query.offset }));
});

app.get('/api/online/download/:jobId', authMiddleware, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(publicJob(job));
});

const astrbotConfigFile = path.join(DATA_DIR, 'astrbot_config.json');
function loadAstrbotConfig() {
  try { return JSON.parse(fs.readFileSync(astrbotConfigFile, 'utf8')); }
  catch { return { address: '', username: '', password: '' }; }
}
function saveAstrbotConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existing = loadAstrbotConfig();
  // An empty password means "keep the current one".
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
// Reject private and loopback targets.
function isPrivateHost(hostname) {
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false;
  if (net.isIP(hostname)) {
    const ip = hostname;
    if (ip.startsWith('10.') || ip.startsWith('172.16.') || ip.startsWith('192.168.')) return true;
    if (ip === '0.0.0.0' || ip.startsWith('127.') || ip.startsWith('169.254.')) return true;
  }
  return false;
}

function astrbotHttp(method, urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('AstrBot 地址无效：' + urlStr)); }
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
  res.json({ address: c.address || '', username: c.username || '' });
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
    res.json({ status: 'ok', command, reply: '', sessionId: sid, address: cfg.address });
  } catch (e) {
    res.json({ status: 'error', message: '调用 AstrBot 出错：' + (e.message || e) });
  }
});

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
      score: v + l * 3,
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

app.get('/', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/app', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', async (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// Unknown API routes return JSON, never the HTML shell.
app.use('/api', async (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`fnOS Comic Reader running at http://0.0.0.0:${PORT}`);
    console.log(`Comics directory: ${COMICS_DIR}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`JWT secret: ${JWT_SECRET.slice(0, 8)}... (持久化)`);

    startAutoDecryptScheduler(readLibs);
  });
}

module.exports = app;
