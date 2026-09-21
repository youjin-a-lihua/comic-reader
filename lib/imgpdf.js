'use strict';
/**
 * 最小 PDF 组装器：把一组 JPEG 直嵌为 PDF 页面（DCTDecode，零重编码）。
 *
 * 为什么手写而不用第三方库：项目依赖里没有 PDF 生成库，而「把多张 JPEG 合成 PDF」
 * 在 PDF 1.4 里只是拼接固定结构的对象 + xref 表，无需引入 pdfkit 之类重依赖；
 * 直嵌 JPEG 流意味着零转码、零画质损失、零 CPU 解码开销。
 *
 * 调用方负责把源图（webp/png/gif…）转成 JPEG 并给出真实宽高与通道数。
 * 输出兼容 Adobe / pdf.js / 主流阅读器。
 */

// 96dpi 像素 → PDF 点（pt）。0.75 让 800×1200px 的图得到 600×900pt（接近 A4）。
const PT_PER_PX = 72 / 96;

function colorSpaceOf(channels) {
  switch (channels) {
    case 1: return { cs: '/DeviceGray', extra: '' };
    case 4: return { cs: '/DeviceCMYK', extra: ' /Decode [1 0 1 0 1 0 1 0]' };
    default: return { cs: '/DeviceRGB', extra: '' };
  }
}

/**
 * @param {Array<{data:Buffer, width:number, height:number, channels?:number}>} images
 * @returns {Buffer} PDF 字节流
 */
function buildPdfFromJpegs(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('buildPdfFromJpegs: images 不能为空');
  }

  const N = images.length;
  const parts = [];
  let offset = 0;
  const offsets = []; // 对象号(1-based) -> 字节偏移

  const put = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    offset += buf.length;
  };
  const begin = (num) => { offsets[num] = offset; };

  // 对象编号：1=Catalog，2=Pages，第 i 页占用 3+i*3 / 3+i*3+1 / 3+i*3+2
  const pageObjNum = (i) => 3 + i * 3;
  const totalObjs = 2 + N * 3;

  put(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));

  // 1) Catalog
  begin(1);
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2) Pages
  begin(2);
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(`${pageObjNum(i)} 0 R`);
  put(`2 0 obj\n<< /Type /Pages /Count ${N} /Kids [${kids.join(' ')}] >>\nendobj\n`);

  for (let i = 0; i < N; i++) {
    const im = images[i];
    const pn = pageObjNum(i);
    const cn = pn + 1;
    const xn = pn + 2;
    const W = +(im.width * PT_PER_PX).toFixed(2);
    const H = +(im.height * PT_PER_PX).toFixed(2);
    const { cs, extra } = colorSpaceOf(im.channels || 3);

    // Page
    begin(pn);
    put(`${pn} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] `
      + `/Resources << /XObject << /Im0 ${xn} 0 R >> >> /Contents ${cn} 0 R >>\nendobj\n`);

    // Contents：把图片铺满整页
    const content = Buffer.from(`q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1');
    begin(cn);
    put(`${cn} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
    put(content);
    put('\nendstream\nendobj\n');

    // Image XObject：原始 JPEG 字节直嵌
    begin(xn);
    put(`${xn} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} `
      + `/ColorSpace ${cs}${extra} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`);
    put(im.data);
    put('\nendstream\nendobj\n');
  }

  // xref 表（每条必须恰好 20 字节：10 位偏移 + 空格 + 5 位代次 + 空格 + 类型 + 空格 + \n）
  const xrefOffset = offset;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xref += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
  }
  put(xref);

  put(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.concat(parts);
}

module.exports = { buildPdfFromJpegs, PT_PER_PX };
