'use strict';
// Minimal PDF writer: embeds JPEGs as DCTDecode pages, no PDF library needed.

// 96dpi pixels to points at 0.75, so 800x1200px becomes 600x900pt, close to A4.
const PT_PER_PX = 72 / 96;

function colorSpaceOf(channels) {
  switch (channels) {
    case 1: return { cs: '/DeviceGray', extra: '' };
    case 4: return { cs: '/DeviceCMYK', extra: ' /Decode [1 0 1 0 1 0 1 0]' };
    default: return { cs: '/DeviceRGB', extra: '' };
  }
}

function buildPdfFromJpegs(images) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('buildPdfFromJpegs: images 不能为空');
  }

  const N = images.length;
  const parts = [];
  let offset = 0;
  const offsets = [];

  const put = (b) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1');
    parts.push(buf);
    offset += buf.length;
  };
  const begin = (num) => { offsets[num] = offset; };

  const pageObjNum = (i) => 3 + i * 3;
  const totalObjs = 2 + N * 3;

  put(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));

  begin(1);
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

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

    begin(pn);
    put(`${pn} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] `
      + `/Resources << /XObject << /Im0 ${xn} 0 R >> >> /Contents ${cn} 0 R >>\nendobj\n`);

    const content = Buffer.from(`q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`, 'latin1');
    begin(cn);
    put(`${cn} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
    put(content);
    put('\nendstream\nendobj\n');

    begin(xn);
    put(`${xn} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} `
      + `/ColorSpace ${cs}${extra} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`);
    put(im.data);
    put('\nendstream\nendobj\n');
  }

  // Every xref entry must be exactly 20 bytes.
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
