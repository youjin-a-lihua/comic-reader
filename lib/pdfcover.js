// Extracts the first JPEG from a PDF without rendering it.

const fs = require('fs');

// Reading the head of the file is enough for the vast majority of scanned PDFs.
const HEAD_BYTES = 24 * 1024 * 1024;
const MIN_JPEG = 2 * 1024; // Anything under 2KB is an icon or a watermark.
const MAX_JPEG = 12 * 1024 * 1024;

function readHead(filePath, bytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function extractFirstJpeg(buf) {
  const DCT = Buffer.from('DCTDecode');
  const STREAM = Buffer.from('stream');
  const ENDSTREAM = Buffer.from('endstream');
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);

  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const dct = buf.indexOf(DCT, from);
    if (dct === -1) return null;
    from = dct + DCT.length;

    const st = buf.indexOf(STREAM, dct);
    if (st === -1) return null;
    if (st > 3 && buf.slice(st - 3, st + 6).toString('latin1') === 'endstream') continue;

    let p = st + STREAM.length;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;

    if (buf.slice(p, p + 3).compare(SOI) !== 0) continue;

    const end = buf.indexOf(ENDSTREAM, p);
    if (end === -1) return null;

    let e = end;
    while (e > p && (buf[e - 1] === 0x0a || buf[e - 1] === 0x0d)) e--;

    const jpeg = buf.slice(p, e);
    if (jpeg.length < MIN_JPEG || jpeg.length > MAX_JPEG) continue;

    return jpeg;
  }
  return null;
}

function extractPdfCover(filePath) {
  try {
    const buf = readHead(filePath, HEAD_BYTES);
    if (!buf) return null;
    if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return null;
    return extractFirstJpeg(buf);
  } catch (err) {
    console.error('[pdfcover]', filePath, err.message);
    return null;
  }
}

module.exports = { extractPdfCover };
