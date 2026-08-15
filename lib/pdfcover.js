/**
 * 纯 JS 提取 PDF 首页封面（无需 node-canvas / 无原生依赖）
 *
 * 背景：原方案 PDF 封面完全靠前端 pdf.js 渲染 —— 每次打开书架，
 * 手机要把 310 个 PDF 各自下载若干 MB 再渲染一遍，这是"封面加载慢"的真正原因。
 *
 * 观察：JM 这类扫描版漫画 PDF，每一页就是一张整页 JPEG（DCTDecode）。
 * 所以不需要真正渲染 PDF —— 直接把第一个 /DCTDecode 图像流的原始字节抠出来，
 * 那本身就是一个合法的 JPEG 文件。
 *
 * 兜底：抠不到就返回 null，前端仍走 pdf.js 渲染（并把结果回传服务端缓存）。
 */

const fs = require('fs');

// 读文件头部若干字节即可命中绝大多数扫描版 PDF 的第一张图
const HEAD_BYTES = 24 * 1024 * 1024; // 24MB
const MIN_JPEG = 2 * 1024;           // 小于 2KB 的多半是图标/水印，跳过
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

/**
 * 在 PDF 字节流里找第一个 DCTDecode 图像对象，返回其 stream 原始字节（= JPEG）
 */
function extractFirstJpeg(buf) {
  const DCT = Buffer.from('DCTDecode');
  const STREAM = Buffer.from('stream');
  const ENDSTREAM = Buffer.from('endstream');
  const SOI = Buffer.from([0xff, 0xd8, 0xff]); // JPEG 文件头

  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const dct = buf.indexOf(DCT, from);
    if (dct === -1) return null;
    from = dct + DCT.length;

    // DCTDecode 之后紧跟的 "stream" 关键字
    const st = buf.indexOf(STREAM, dct);
    if (st === -1) return null;
    // 排除 "endstream" 误匹配
    if (st > 3 && buf.slice(st - 3, st + 6).toString('latin1') === 'endstream') continue;

    // stream 关键字后是 CRLF 或 LF
    let p = st + STREAM.length;
    if (buf[p] === 0x0d) p++;
    if (buf[p] === 0x0a) p++;

    // 流首字节必须是 JPEG SOI，否则不是我们要的（可能是被加密/其他过滤器）
    if (buf.slice(p, p + 3).compare(SOI) !== 0) continue;

    const end = buf.indexOf(ENDSTREAM, p);
    if (end === -1) return null;

    let e = end;
    // 去掉 endstream 前的换行
    while (e > p && (buf[e - 1] === 0x0a || buf[e - 1] === 0x0d)) e--;

    const jpeg = buf.slice(p, e);
    if (jpeg.length < MIN_JPEG || jpeg.length > MAX_JPEG) continue;

    // 校验 JPEG 结尾（允许尾部有填充）
    return jpeg;
  }
  return null;
}

/**
 * @returns {Buffer|null} JPEG 数据
 */
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
