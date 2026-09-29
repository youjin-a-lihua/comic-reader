'use strict';
// Image proxy for online sources: fetch, decode, cache, with SSRF and CRLF guards.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const registry = require('./sources');

// Response cap: 20MB.
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const MAX_CACHE = 200;
const _cache = new Map();

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

// Resolve DNS and check every address returned; string matching misses IPv6, decimal IPs and DNS rebinding.

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isPrivateIPv4(mapped) : true;
  }
  const compat = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (compat) return net.isIPv4(compat[1]) ? isPrivateIPv4(compat[1]) : true;
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v)) return true;
  return false;
}

async function ssrfCheck(u) {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '仅支持 http/https';
  const host = (u.hostname || '').toLowerCase();
  if (!host) return '主机无效';

  let addrs;
  try {
    const res = await dns.promises.lookup(host, { all: true });
    addrs = (res || []).map(x => x.address);
  } catch {
    return `域名解析失败，已拒绝：${host}`;
  }
  if (!addrs.length) return `域名解析无结果，已拒绝：${host}`;

  for (const addr of addrs) {
    const fam = net.isIP(addr);
    if (fam === 4) {
      if (isPrivateIPv4(addr)) return `禁止访问内网地址 ${addr}`;
    } else if (fam === 6) {
      if (isPrivateIPv6(addr)) return `禁止访问内网地址 ${addr}`;
    } else {
      return `无法识别的地址 ${addr}`;
    }
  }
  return null;
}

// Strip CR/LF from header values that come from user or config input.
function sanitizeHeaderValue(v) {
  return String(v).replace(/[\r\n]/g, '');
}

function fetchImage(u) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'Referer': 'https://localhost/',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      'X-Requested-With': 'com.example.app',
    };
    for (const k of Object.keys(headers)) headers[k] = sanitizeHeaderValue(headers[k]);

    const req = lib.get(u, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      let total = 0;
      res.on('data', d => {
        total += d.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy(new Error('图片过大（超过 20MB）'));
          return;
        }
        chunks.push(d);
      });
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'image/webp' }));
    });
    // 20s timeout so an unresponsive origin cannot pin the request.
    req.setTimeout(20000, () => req.destroy(new Error('拉取超时')));
    req.on('error', reject);
  });
}

async function getOnlineImage(urlStr) {
  if (typeof urlStr !== 'string' || /[\r\n]/.test(urlStr)) return { error: 'URL 含非法字符' };
  let u;
  try { u = new URL(urlStr); } catch { return { error: 'URL 无效' }; }
  const ssrf = await ssrfCheck(u);
  if (ssrf) return { error: ssrf };

  // Route by URL: whichever enabled source recognises it also decodes it.
  const source = registry.findDecoder(u);
  if (!source) return { error: '在线漫画模块未启用（ONLINE_SOURCE 未设置）' };

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
    if (parsed.kind === 'photo') outType = 'image/webp';
  }
  cacheSet(urlStr, out, outType);
  return { buffer: out, contentType: outType, cached: false };
}

module.exports = { getOnlineImage };
