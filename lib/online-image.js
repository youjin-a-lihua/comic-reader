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
const dns = require('dns');
const net = require('net');
const registry = require('./sources');

// 拉取上限：响应体超过此值直接中止，避免异常/恶意大图吃满内存
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20MB

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

// ── SSRF 防护 ────────────────────────────────────────
// 旧版只做字符串匹配（点分十进制 IPv4），可被轻易绕过：
//   - IPv6 字面量（http://[::1]/）
//   - 十进制整数 IP（http://2130706433/）
//   - 域名解析到内网（DNS 指向 127.0.0.1 / 192.168.x）
// 正确做法：先做 DNS 解析，再对解析出的每个 IP 判定地址族。
// 解析失败 / 无结果 → 直接拒绝（fail-closed）。

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // 畸形 → 拒绝
  const [a, b] = p;
  if (a === 0) return true;                    // 0.0.0.0/8（含 0.0.0.0）
  if (a === 10) return true;                   // 10.0.0.0/8
  if (a === 127) return true;                  // 127.0.0.0/8
  if (a === 169 && b === 254) return true;     // 169.254.0.0/16（含 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;     // 192.168.0.0/16
  return false;
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;  // 未指定 / 环回
  // IPv4-mapped IPv6（::ffff:1.2.3.4）→ 还原成 IPv4 再判
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice('::ffff:'.length);
    return net.isIPv4(mapped) ? isPrivateIPv4(mapped) : true;
  }
  // IPv4-compatible（::1.2.3.4，已废弃）同样按 IPv4 处理
  const compat = /^::(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (compat) return net.isIPv4(compat[1]) ? isPrivateIPv4(compat[1]) : true;
  // 唯一本地地址 fc00::/7（fc / fd 前缀）
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  // 链路本地地址 fe80::/10（fe80–febf）
  if (/^fe[89ab]/.test(v)) return true;
  return false;
}

// 返回可读错误信息；null 表示允许
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

// 去掉请求头值里的 \r \n，防止用户可控内容注入额外请求头（CRLF 注入）
function sanitizeHeaderValue(v) {
  return String(v).replace(/[\r\n]/g, '');
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
    // 任何由外部/配置拼入的头部值都必须经过 CRLF 清洗
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
    // 超时控制（20s）：源站不响应时不会永久挂住请求
    req.setTimeout(20000, () => req.destroy(new Error('拉取超时')));
    req.on('error', reject);
  });
}

// ── 对外：取在线图片（含缓存）────────────────────────
// 返回 { buffer, contentType, cached } 或 { error }
async function getOnlineImage(urlStr) {
  // CRLF 注入防护：URL 本身含 \r \n 即可在底层拼出额外请求头/行，直接拒绝
  if (typeof urlStr !== 'string' || /[\r\n]/.test(urlStr)) return { error: 'URL 含非法字符' };
  let u;
  try { u = new URL(urlStr); } catch { return { error: 'URL 无效' }; }
  const ssrf = await ssrfCheck(u);
  if (ssrf) return { error: ssrf };

  // 多源：按 URL 自动路由到认得它的源做还原；未命中则用首个启用源
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
    // jm 等内容图还原后统一输出 webp；封面等保持原格式
    if (parsed.kind === 'photo') outType = 'image/webp';
  }
  cacheSet(urlStr, out, outType);
  return { buffer: out, contentType: outType, cached: false };
}

module.exports = { getOnlineImage };
