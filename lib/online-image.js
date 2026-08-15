'use strict';
/**
 * 在线图片代理（通用）：拉取 + 调用当前源的 decodeImage 还原 + 内存缓存
 *
 * 前端 <img> 直接引用 /api/online/img?url=<原图URL> 即可显示还原后的图片，
 * 无需自己处理 Referer / 防盗链 / 乱序。具体还原逻辑由「在线源」实现，本文件只负责
 * SSRF 防护、下载、缓存和按源派发。
 */
const http = require('http');
const https = require('https');
const registry = require('./sources');

// ── 内存 LRU 缓存（key = url）─────────────────────────
const MAX_CACHE = 200;
const _cache = new Map(); // url -> { buffer, contentType, ts }

function cacheGet(url) {
  const hit = _cache.get(url);
  if (!hit) return null;
  _cache.delete(url);
  _cache.set(url, hit);
  return hit;
}
function cacheSet(url, buffer, contentType) {
  _cache.set(url, { buffer, contentType, ts: Date.now() });
  while (_cache.size > MAX_CACHE) {
    _cache.delete(_cache.keys().next().value);
  }
}

// ── SSRF 防护：仅允许 http/https 的域名，禁止 localhost / IP 直连 ──
function ssrfError(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '仅支持 http/https';
  const host = (u.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return '主机无效';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return '不允许 IP 直连';
  return null;
}

// ── 拉取（带 Referer/UA 绕过防盗链）───────────────────
function fetchImage(u) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Referer': 'https://localhost/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'X-Requested-With': 'com.example.app',
    };
    const req = lib.get(u, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/webp' }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('拉取超时')));
    req.on('error', reject);
  });
}

// ── 对外：取在线图片（含缓存）────────────────────────
// 返回 { buffer, contentType, cached } 或 { error }
async function getOnlineImage(urlStr) {
  const source = registry.getActiveSource();
  if (!source) return { error: '在线漫画模块未启用（ONLINE_SOURCE 未设置）' };

  let u;
  try { u = new URL(urlStr); } catch { return { error: 'URL 无效' }; }
  const ssrf = ssrfError(u);
  if (ssrf) return { error: ssrf };

  if (typeof source.parseImageUrl !== 'function') return { error: '当前在线源未实现图片解析' };
  const parsed = source.parseImageUrl(u);
  if (!parsed) return { error: '当前在线源不支持此图片 URL' };

  const cached = cacheGet(urlStr);
  if (cached) return { buffer: cached.buffer, contentType: cached.contentType, cached: true };

  const { buffer, contentType } = await fetchImage(u);
  let out = buffer;
  let outType = contentType;
  if (typeof source.decodeImage === 'function') {
    out = await source.decodeImage(buffer, parsed);
    // jm 等内容图还原后统一输出 webp；封面等保持原格式
    if (parsed.kind === 'photo') outType = 'image/webp';
  }
  cacheSet(urlStr, out, outType);
  return { buffer: out, contentType: outType, cached: false };
}

module.exports = { getOnlineImage };
