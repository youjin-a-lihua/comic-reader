'use strict';
// Online source implementation for jm.
const https = require('https');
const crypto = require('crypto');

const sharp = require('sharp');

const JM_VERSION = '2.0.16';
const JM_PKG = 'com.example.app';
const JM_AUTH_KEY = '18comicAPPContent';
const JM_SECRET_KEY = '185Hcomic3PAPP7R';
const UA = 'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';

const API_DOMAINS = [
  'www.cdnhjk.net', 'www.cdngwc.cc', 'www.cdngwc.net', 'www.cdngwc.club', 'www.cdnutc.me',
  'www.cdntwice.org', 'www.cdnsha.org', 'www.cdnaspa.cc', 'www.cdnntr.cc',
];

// Image host default; the live value comes from the /setting response.
let imageHost = 'https://cdn-msp.jmapinodeudzn.net';
let apiHost = null;
let probePromise = null;

function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function convertData(input, secret) {
  const key = Buffer.from(md5hex(secret), 'utf8');
  const data = Buffer.from(input, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(true);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  let res = decrypted.toString('utf8');
  let start = 0;
  while (start < res.length && res[start] !== '{' && res[start] !== '[') start++;
  let end = res.length - 1;
  while (end > start && res[end] !== '}' && res[end] !== ']') end--;
  return res.substring(start, end + 1);
}

function buildHeaders(time) {
  return {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://localhost',
    'Referer': 'https://localhost/',
    'X-Requested-With': JM_PKG,
    'Authorization': 'Bearer',
    'token': md5hex(`${time}${JM_AUTH_KEY}`),
    'tokenparam': `${time},${JM_VERSION}`,
    'User-Agent': UA,
  };
}

function httpGet(host, path) {
  return new Promise((resolve, reject) => {
    const time = Math.floor(Date.now() / 1000);
    const req = https.get({ hostname: host, path, headers: buildHeaders(time), timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), time }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Probe the API host candidates and cache whichever answers.
async function probe() {
  for (const host of API_DOMAINS) {
    try {
      const { status, body, time } = await httpGet(host, '/setting?app_img_shunt=1&express=');
      if (status !== 200) continue;
      const json = JSON.parse(body);
      if (typeof json.data !== 'string') continue;
      const plain = convertData(json.data, `${time}${JM_SECRET_KEY}`);
      const setting = JSON.parse(plain);
      if (setting.img_host) imageHost = setting.img_host;
      apiHost = host;
      return host;
    } catch {  }
  }
  throw new Error('jm API 无可用域名');
}

async function ensureHost() {
  if (apiHost) return apiHost;
  if (!probePromise) probePromise = probe().catch(e => { probePromise = null; throw e; });
  return probePromise;
}

async function jmGet(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = await ensureHost();
    const { status, body, time } = await httpGet(host, path);
    if (status !== 200) {
      apiHost = null;
      probePromise = null;
      if (attempt === 0) continue;
      throw new Error('jm API HTTP ' + status);
    }
    const json = JSON.parse(body);
    if (typeof json.data !== 'string') throw new Error('jm API 返回格式异常');
    return JSON.parse(convertData(json.data, `${time}${JM_SECRET_KEY}`));
  }
  throw new Error('jm API 调用失败');
}

function getCoverUrl(id) { return `${imageHost}/media/albums/${id}_3x4.jpg`; }
function getImageUrl(epId, name) { return `${imageHost}/media/photos/${epId}/${name}`; }

function parseComic(c) {
  const id = String(c.id);
  const tags = [];
  if (c.category && c.category.title) tags.push(c.category.title);
  if (c.category_sub && c.category_sub.title) tags.push(c.category_sub.title);
  return {
    id,
    title: c.name || '',
    author: c.author || '',
    cover: getCoverUrl(id),
    tags,
    description: c.description || '',
  };
}

async function search(keyword, order, page) {
  keyword = encodeURIComponent(String(keyword || '').trim()).replace(/%20/g, '+');
  const o = order || 'mr';
  let path = `/search?search_query=${keyword}&o=${o}`;
  if (page > 1) path += `&page=${page}`;
  const data = await jmGet(path);
  const total = data.total || 0;
  const maxPage = Math.max(1, Math.ceil(total / 80));
  const comics = (data.content || []).map(parseComic);
  return { total, maxPage, comics };
}

async function album(id) {
  id = String(id).replace(/^jm/, '');
  const data = await jmGet(`/album?id=${id}`);
  const author = data.author || [];
  const works = data.works || [];
  const actors = data.actors || [];
  const tags = data.tags || [];
  const series = (data.series || []).sort((a, b) => a.sort - b.sort);
  const chapters = series.map(e => ({
    id: String(e.id),
    title: (e.name || '').trim() || `第${e.sort}話`,
  }));
  if (chapters.length === 0) chapters.push({ id, title: '第1話' });
  const related = (data.related_list || []).map(e => ({
    id: String(e.id),
    title: e.name || '',
    author: e.author || '',
    cover: getCoverUrl(e.id),
    description: e.description || '',
  }));
  let updateDate = '';
  if (data.addtime) {
    const d = new Date(data.addtime * 1000);
    updateDate = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  return {
    id,
    title: data.name || '',
    author: author.join(', '),
    cover: getCoverUrl(id),
    description: data.description || '',
    likes: Number(data.likes) || 0,
    tags: { author, works, actors, tags },
    views: data.total_views ? [data.total_views] : [],
    updateDate,
    chapters,
    related,
  };
}

async function chapter(epId) {
  const data = await jmGet(`/chapter?id=${epId}`);
  const images = (data.images || []).map(name => getImageUrl(epId, name));
  return { epId: String(epId), images };
}

function computeScrambleNum(epId, pictureName) {
  epId = Number(epId);
  if (epId < 220980) return 0;
  if (epId < 268850) return 10;
  const hash = crypto.createHash('md5').update(String(epId) + pictureName).digest('hex');
  const charCode = hash.charCodeAt(hash.length - 1);
  if (epId > 421926) return (charCode % 8) * 2 + 2;
  return (charCode % 10) * 2 + 2;
}

async function decodeImage(buffer, parsed) {
  if (parsed.kind !== 'photo' || parsed.isGif) return buffer;
  const num = computeScrambleNum(parsed.epId, parsed.pictureName);
  if (num <= 1) return buffer;
  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  // Very short images round blockSize down to 0; reordering must be skipped for those.
  if (!w || !h || h < num * 2) return buffer;
  const blockSize = Math.floor(h / num);
  const remainder = h % num;
  const blocks = [];
  for (let i = 0; i < num; i++) {
    const start = i * blockSize;
    const end = start + blockSize + (i !== num - 1 ? 0 : remainder);
    blocks.push({ top: start, height: end - start });
  }
  let y = 0;
  const composite = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    const block = await sharp(buffer)
      .extract({ left: 0, top: b.top, width: w, height: b.height })
      .toBuffer();
    composite.push({ input: block, top: y, left: 0 });
    y += b.height;
  }
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } }
  })
    .composite(composite)
    .webp({ quality: 90 })
    .toBuffer();
}

function parseImageUrl(u) {
  if (/^\/media\/albums\/[^/]+\.(jpg|jpeg|png|webp)$/i.test(u.pathname)) {
    return { kind: 'cover', isGif: false };
  }
  const m = /^\/media\/photos\/(\d+)\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  const epId = m[1];
  const file = m[2];
  const isGif = /\.gif$/i.test(file);
  const pictureName = file.replace(/\.[^.]+$/, '');
  return { kind: 'photo', epId, pictureName, isGif };
}

module.exports = {
  name: 'jm',
  label: '禁漫天堂',
  search, album, chapter, getCoverUrl, getImageUrl,
  decodeImage, parseImageUrl,
  get imageHost() { return imageHost; },
};
