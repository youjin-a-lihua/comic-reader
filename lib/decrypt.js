/**
 * 纯 JS PDF 解密（零原生依赖，可移植到 GitHub 直接部署）
 *
 * 解决背景：JM 漫画 PDF 用标准安全处理器加密（/V 2 /R 3，128-bit RC4，
 * 主人密码 11110000）。浏览器 pdf.js 无法打开，且缺封面。
 * 本模块实现 PDF 规范的安全处理器算法 2/3/5/7/1：
 *   - 从主人密码反推用户密码（算法 7）
 *   - 计算文档加密密钥（算法 2）
 *   - 逐对象派生对象密钥（算法 1）并 RC4 解密流与字符串
 * RC4 是等长密码，原地解密后 xref 偏移不变，得到可直接被 pdf.js / pdf-lib 打开的明文 PDF。
 *
 * 仅支持 RC4（/V2 /R3 /R2）。AES 变体（/V4 /R4 AESV2、/V5 /R5/R6）目前不在 JM 漫画范围内，
 * 检测到会明确报错而不是静默产出损坏文件。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');

// PDF 标准 32 字节填充串（算法中密码不足 32 字节时从开头补齐）
const PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex'
);

// ---------- 基础密码原语 ----------

function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 255;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  const out = Buffer.allocUnsafe(data.length);
  let i = 0;
  let j2 = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j2 = (j2 + S[i]) & 255;
    const t = S[i];
    S[i] = S[j2];
    S[j2] = t;
    out[k] = data[k] ^ S[(S[i] + S[j2]) & 255];
  }
  return out;
}

function md5(b) {
  return crypto.createHash('md5').update(b).digest();
}

// 密码补齐到 32 字节（标准：密码 + PADDING 取前 32 字节）
function pad32(pw) {
  const p = Buffer.isBuffer(pw) ? pw : Buffer.from(String(pw), 'latin1');
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = i < p.length ? p[i] : PADDING[i - p.length];
  return b;
}

// 算法 3：由主人密码计算 O 值密钥
function computeOKey(ownerPW, keySizeBytes) {
  let h = md5(pad32(ownerPW));
  for (let i = 0; i < 50; i++) h = md5(h);
  return h.slice(0, keySizeBytes);
}

// 算法 7：由主人密码反推用户密码
function recoverUserPassword(ownerPW, O, rev, keySizeBytes) {
  const okey = computeOKey(ownerPW, keySizeBytes);
  let p = Buffer.from(O);
  if (rev <= 2) {
    p = rc4(okey, p);
  } else {
    for (let i = 19; i >= 0; i--) {
      const k = Buffer.from(okey);
      for (let b = 0; b < k.length; b++) k[b] ^= i;
      p = rc4(k, p);
    }
  }
  return p;
}

// 算法 2：计算文档加密密钥
function computeEncryptionKey(userPW, O, P, id1, rev, keySizeBytes) {
  const a = pad32(userPW);
  let h = md5(
    Buffer.concat([
      a,
      O,
      Buffer.from([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]),
      id1,
    ])
  );
  for (let i = 0; i < 50; i++) h = md5(h.slice(0, keySizeBytes));
  return h.slice(0, keySizeBytes);
}

// 算法 5（rev>=3）：计算 U 值，用于校验密码是否正确
function computeUValue(encKey, rev, id1, keySizeBytes) {
  if (rev <= 2) return rc4(encKey, PADDING);
  let u = md5(Buffer.concat([PADDING, id1]));
  u = rc4(encKey, u);
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(encKey);
    for (let b = 0; b < k.length; b++) k[b] ^= i;
    u = rc4(k, u);
  }
  return pad32(u);
}

// 算法 1：逐对象派生对象密钥
function deriveObjectKey(encKey, objNum, gen, v, lengthBits) {
  const n = v === 1 ? 5 : lengthBits / 8;
  const keyData = Buffer.concat([
    encKey.slice(0, n),
    Buffer.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff]),
    Buffer.from([gen & 0xff, (gen >> 8) & 0xff]),
  ]);
  return md5(keyData).slice(0, Math.min(n + 5, 16));
}

// ---------- 解析加密字典 ----------

function getInt(text, re) {
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}
function getHex(text, re) {
  const m = text.match(re);
  return m ? Buffer.from(m[1], 'hex') : null;
}

/**
 * 探测 PDF 是否加密，并解析加密字典。
 * @returns {null | {V,R,Length,O,U,P,id1,encObjNum,encGen,stmf,strf,encrypted:true}}
 */
function parseEncryption(buf) {
  const s = buf.toString('latin1');
  const encRef = s.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
  if (!encRef) return null;

  const encObjNum = parseInt(encRef[1], 10);
  const encGen = parseInt(encRef[2], 10);

  // 找到加密字典对象的正文
  const re = new RegExp('(\\d+)\\s+(\\d+)\\s+obj([\\s\\S]*?)endobj', 'g');
  let m;
  let body = null;
  while ((m = re.exec(s))) {
    if (parseInt(m[1], 10) === encObjNum) {
      body = m[3];
      break;
    }
  }
  if (!body) return null;

  const V = getInt(body, /\/V\s+(\d+)/) ?? 0;
  const R = getInt(body, /\/R\s+(\d+)/) ?? 0;
  const Length = getInt(body, /\/Length\s+(\d+)/) ?? 128;
  const O = getHex(body, /\/O\s*<([0-9A-Fa-f]+)>/);
  const U = getHex(body, /\/U\s*<([0-9A-Fa-f]+)>/);
  const Praw = getInt(body, /\/P\s+(-?\d+)/);
  const P = (Praw >>> 0) & 0xffffffff;
  const idMatch = s.match(/\/ID\s*\[\s*<([0-9A-Fa-f]+)>/);
  const id1 = idMatch ? Buffer.from(idMatch[1], 'hex') : Buffer.alloc(0);

  // 加密方法：/StmF、/StrF 默认 /V2（RC4）；若显式 AESV2 则不支持
  const stmf = (body.match(/\/StmF\s*\/(\w+)/) || [, '/V2'])[1];
  const strf = (body.match(/\/StrF\s*\/(\w+)/) || [, '/V2'])[1];

  if (/AES/i.test(stmf) || /AES/i.test(strf)) {
    return { encrypted: true, unsupported: true, stmf, strf, encObjNum, encGen };
  }

  return { encrypted: true, V, R, Length, O, U, P, id1, encObjNum, encGen, stmf, strf };
}

/**
 * 尝试用给定密码（优先用户密码；失败则用主人密码反推）得到可用的加密密钥。
 * @returns {{ok:boolean, encKey?:Buffer, reason?:string}}
 */
function resolveKey(info, opts) {
  const keySizeBytes = Math.max(5, Math.floor(info.Length / 8));
  const P = info.P;
  const id1 = info.id1;

  const tryWith = (userPW) => {
    const ek = computeEncryptionKey(userPW, info.O, P, id1, info.R, keySizeBytes);
    const uVal = computeUValue(ek, info.R, id1, keySizeBytes);
    // rev>=3 比较前 16 字节
    const len = info.R >= 3 ? 16 : 32;
    if (uVal.slice(0, len).equals(info.U.slice(0, len))) return ek;
    return null;
  };

  if (opts.userPassword) {
    const ek = tryWith(pad32(opts.userPassword));
    if (ek) return { ok: true, encKey: ek };
  }
  if (opts.ownerPassword) {
    const upw = recoverUserPassword(opts.ownerPassword, info.O, info.R, keySizeBytes);
    const ek = tryWith(upw);
    if (ek) return { ok: true, encKey: ek };
  }
  return { ok: false, reason: 'password rejected (U value mismatch)' };
}

// ---------- 字符串解密辅助 ----------

function isWS(c) {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

// 在 [regionStart, regionEnd) 范围内，用 objKey 解密所有字面串 (...) 与十六进制串 <...>
function decryptStringsInRegion(out, s, regionStart, regionEnd, objKey) {
  // 字面串：\((?:\\.|[^()\\])*\)
  const litRe = /\((?:\\.|[^()\\])*\)/g;
  litRe.lastIndex = regionStart;
  let lm;
  while ((lm = litRe.exec(s))) {
    const start = lm.index;
    const end = lm.index + lm[0].length;
    if (start >= regionEnd) break;
    if (start < regionStart) continue;
    // 解密括号之间的内容（不含括号）
    const innerStart = start + 1;
    const innerEnd = end - 1;
    if (innerEnd > innerStart) {
      const dec = rc4(objKey, out.slice(innerStart, innerEnd));
      dec.copy(out, innerStart);
    }
  }
  // 十六进制串：<...>
  const hexRe = /<([0-9A-Fa-f\s]*)>/g;
  hexRe.lastIndex = regionStart;
  let hm;
  while ((hm = hexRe.exec(s))) {
    const start = hm.index;
    const end = hm.index + hm[0].length;
    if (start >= regionEnd) break;
    if (start < regionStart) continue;
    const innerStart = start + 1;
    const innerEnd = end - 1;
    const hexText = s.slice(innerStart, innerEnd).replace(/\s+/g, '');
    if (hexText.length % 2 !== 0 || hexText.length === 0) continue;
    const raw = Buffer.from(hexText, 'hex');
    const dec = rc4(objKey, raw);
    const newHex = dec.toString('hex');
    // 等长替换
    Buffer.from(newHex, 'latin1').copy(out, innerStart);
  }
}

// 找到对象内真正的 'stream' 关键字位置（后跟换行），排除 'endstream' 中的子串
function findStreamKeyword(buf, s, from, objEnd) {
  let pos = from;
  while (true) {
    const st = s.indexOf('stream', pos);
    if (st === -1 || st > objEnd) return -1;
    // 真 stream 关键字前一个是空白，后一个是换行
    if ((st === 0 || isWS(buf[st - 1])) && (buf[st + 6] === 0x0d || buf[st + 6] === 0x0a)) {
      return st;
    }
    pos = st + 6;
  }
}

/**
 * 解密整个 PDF 缓冲。
 * @param {Buffer} buf 原始加密 PDF
 * @param {{userPassword?:string, ownerPassword?:string}} [opts]
 * @returns {{ok:boolean, buf:Buffer, reason?:string, encrypted:boolean}}
 */
function decryptPdfBuffer(buf, opts = {}) {
  const info = parseEncryption(buf);
  if (!info) return { ok: true, encrypted: false, buf };

  if (info.unsupported) {
    return {
      ok: false,
      encrypted: true,
      buf,
      reason: `不支持的加密算法（StmF/StrF=${info.stmf}/${info.strf}），本模块仅支持 RC4`,
    };
  }

  const keyRes = resolveKey(info, opts);
  if (!keyRes.ok) {
    return { ok: false, encrypted: true, buf, reason: keyRes.reason };
  }
  const encKey = keyRes.encKey;

  const s = buf.toString('latin1');
  const out = Buffer.from(buf); // 原地解密（等长）

  // 枚举所有间接对象
  const objRe = /(\d+)\s+(\d+)\s+obj/g;
  let om;
  const objects = [];
  while ((om = objRe.exec(s))) {
    const objNum = parseInt(om[1], 10);
    const gen = parseInt(om[2], 10);
    const start = om.index;
    const end = s.indexOf('endobj', start);
    if (end === -1) break;
    objects.push({ objNum, gen, start, end: end + 6 });
  }

  for (const o of objects) {
    if (o.objNum === info.encObjNum) continue; // 跳过加密字典本身
    const objKey = deriveObjectKey(encKey, o.objNum, o.gen, info.V, info.Length);

    // 1) 解密流数据
    const st = findStreamKeyword(buf, s, o.start, o.end);
    let dictEnd = o.end;
    if (st !== -1) {
      let dp = st + 6;
      if (buf[dp] === 0x0d) dp++;
      if (buf[dp] === 0x0a) dp++;
      const e = s.indexOf('endstream', dp);
      if (e !== -1) {
        let dataEnd = e;
        while (dataEnd > dp && (buf[dataEnd - 1] === 0x0a || buf[dataEnd - 1] === 0x0d)) dataEnd--;
        if (dataEnd > dp) {
          const dec = rc4(objKey, out.slice(dp, dataEnd));
          dec.copy(out, dp);
        }
        dictEnd = st; // 字符串只解密字典区（流之前）
      }
    }
    // 2) 解密字典中的字符串
    decryptStringsInRegion(out, s, o.start, dictEnd, objKey);
  }

  // 移除 trailer 中的 /Encrypt 引用
  const outS = out.toString('latin1');
  const newS = outS.replace(/\/Encrypt\s+\d+\s+\d+\s+R/, '');
  const result = Buffer.from(newS, 'latin1');

  return { ok: true, encrypted: true, buf: result, encKey };
}

/**
 * 判断缓冲是否为加密 PDF。
 * 注意：/Encrypt 引用位于 trailer（文件尾部），可能远在 64KB 之后，
 * 因此扫描整段缓冲而非仅文件头。漫画类 PDF 通常仅数 MB，开销可接受。
 */
function isEncryptedPdf(buf) {
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(buf.toString('latin1'));
}

/**
 * 解密文件（原地替换），可选先备份。
 * @returns {{ok:boolean, reason?:string, encrypted:boolean, backup?:string}}
 */
function decryptFileInPlace(filePath, opts = {}) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: `读取失败: ${err.message}`, encrypted: false };
  }
  if (!isEncryptedPdf(buf)) return { ok: true, encrypted: false };

  const res = decryptPdfBuffer(buf, opts);
  if (!res.ok) return { ok: false, reason: res.reason, encrypted: true };

  if (opts.backup) {
    const backupPath = filePath + '.enc.bak';
    try {
      fs.copyFileSync(filePath, backupPath);
      res.backup = backupPath;
    } catch (err) {
      return { ok: false, reason: `备份失败: ${err.message}`, encrypted: true };
    }
  }

  try {
    fs.writeFileSync(filePath, res.buf);
  } catch (err) {
    return { ok: false, reason: `写回失败: ${err.message}`, encrypted: true };
  }
  return { ok: true, encrypted: true, backup: res.backup };
}

module.exports = {
  rc4,
  md5,
  pad32,
  computeOKey,
  recoverUserPassword,
  computeEncryptionKey,
  computeUValue,
  deriveObjectKey,
  parseEncryption,
  isEncryptedPdf,
  decryptPdfBuffer,
  decryptFileInPlace,
};
