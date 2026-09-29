// PDF decryption helpers, pure JS, no native dependencies.

'use strict';

const crypto = require('crypto');
const fs = require('fs');

const PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex'
);

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

function pad32(pw) {
  const p = Buffer.isBuffer(pw) ? pw : Buffer.from(String(pw), 'latin1');
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = i < p.length ? p[i] : PADDING[i - p.length];
  return b;
}

function computeOKey(ownerPW, keySizeBytes) {
  let h = md5(pad32(ownerPW));
  for (let i = 0; i < 50; i++) h = md5(h);
  return h.slice(0, keySizeBytes);
}

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

function deriveObjectKey(encKey, objNum, gen, v, lengthBits) {
  const n = v === 1 ? 5 : lengthBits / 8;
  const keyData = Buffer.concat([
    encKey.slice(0, n),
    Buffer.from([objNum & 0xff, (objNum >> 8) & 0xff, (objNum >> 16) & 0xff]),
    Buffer.from([gen & 0xff, (gen >> 8) & 0xff]),
  ]);
  return md5(keyData).slice(0, Math.min(n + 5, 16));
}

function getInt(text, re) {
  const m = text.match(re);
  return m ? parseInt(m[1], 10) : null;
}
function getHex(text, re) {
  const m = text.match(re);
  return m ? Buffer.from(m[1], 'hex') : null;
}

function parseEncryption(buf) {
  const s = buf.toString('latin1');
  const encRef = s.match(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/);
  if (!encRef) return null;

  const encObjNum = parseInt(encRef[1], 10);
  const encGen = parseInt(encRef[2], 10);

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

  const stmf = (body.match(/\/StmF\s*\/(\w+)/) || [, '/V2'])[1];
  const strf = (body.match(/\/StrF\s*\/(\w+)/) || [, '/V2'])[1];

  if (/AES/i.test(stmf) || /AES/i.test(strf)) {
    return { encrypted: true, unsupported: true, stmf, strf, encObjNum, encGen };
  }

  return { encrypted: true, V, R, Length, O, U, P, id1, encObjNum, encGen, stmf, strf };
}

function resolveKey(info, opts) {
  const keySizeBytes = Math.max(5, Math.floor(info.Length / 8));
  const P = info.P;
  const id1 = info.id1;

  const tryWith = (userPW) => {
    const ek = computeEncryptionKey(userPW, info.O, P, id1, info.R, keySizeBytes);
    const uVal = computeUValue(ek, info.R, id1, keySizeBytes);
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

function isWS(c) {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

function decryptStringsInRegion(out, s, regionStart, regionEnd, objKey) {
  const litRe = /\((?:\\.|[^()\\])*\)/g;
  litRe.lastIndex = regionStart;
  let lm;
  while ((lm = litRe.exec(s))) {
    const start = lm.index;
    const end = lm.index + lm[0].length;
    if (start >= regionEnd) break;
    if (start < regionStart) continue;
    const innerStart = start + 1;
    const innerEnd = end - 1;
    if (innerEnd > innerStart) {
      const dec = rc4(objKey, out.slice(innerStart, innerEnd));
      dec.copy(out, innerStart);
    }
  }
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
    Buffer.from(newHex, 'latin1').copy(out, innerStart);
  }
}

function findStreamKeyword(buf, s, from, objEnd) {
  let pos = from;
  while (true) {
    const st = s.indexOf('stream', pos);
    if (st === -1 || st > objEnd) return -1;
    if ((st === 0 || isWS(buf[st - 1])) && (buf[st + 6] === 0x0d || buf[st + 6] === 0x0a)) {
      return st;
    }
    pos = st + 6;
  }
}

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
  const out = Buffer.from(buf);

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
    if (o.objNum === info.encObjNum) continue;
    const objKey = deriveObjectKey(encKey, o.objNum, o.gen, info.V, info.Length);

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
        dictEnd = st;
      }
    }
    decryptStringsInRegion(out, s, o.start, dictEnd, objKey);
  }

  const outS = out.toString('latin1');
  const newS = outS.replace(/\/Encrypt\s+\d+\s+\d+\s+R/, '');
  const result = Buffer.from(newS, 'latin1');

  return { ok: true, encrypted: true, buf: result, encKey };
}

function isEncryptedPdf(buf) {
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(buf.toString('latin1'));
}

// Encryption is detected from the last 256KB only: the trailer sits at the end of the file, and reading whole PDFs cost about 1.6TB/day.
const ENC_TAIL_BYTES = parseInt(process.env.DECRYPT_TAIL_BYTES || '262144', 10);

function sniffEncryptedPdf(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    return { verdict: 'unknown', reason: '打开失败: ' + e.message };
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { verdict: 'unknown', reason: '空文件' };
    const len = Math.min(size, ENC_TAIL_BYTES);
    const tail = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, tail, got, len - got, size - len + got);
      if (n <= 0) break;
      got += n;
    }
    const win = tail.subarray(0, got);
    if (isEncryptedPdf(win)) return { verdict: 'encrypted' };
    if (win.includes('%%EOF')) return { verdict: 'plain' };
    return { verdict: 'unknown', reason: '尾部窗口未见 %%EOF' };
  } catch (e) {
    return { verdict: 'unknown', reason: '读取失败: ' + e.message };
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function decryptFileInPlace(filePath, opts = {}) {
  const sniff = sniffEncryptedPdf(filePath);
  if (sniff.verdict === 'plain') return { ok: true, encrypted: false };

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
