/**
 * EPUB 解析模块
 * EPUB 本质是 ZIP，结构：
 *   META-INF/container.xml → 指向 .opf 文件
 *   .opf → metadata + manifest + spine（阅读顺序）
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

let cache = {}; // { [filePath]: { opf, manifest, spine, metadata } }
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * 从 EPUB 中读取文本文件内容
 */
function readTextFromZip(zip, entryName) {
  try {
    const data = zip.readFile(entryName);
    return data ? data.toString('utf-8') : null;
  } catch {
    return null;
  }
}

/**
 * 解析 container.xml，获取 OPF 路径
 */
function getOpfPath(zip) {
  const containerXml = readTextFromZip(zip, 'META-INF/container.xml');
  if (!containerXml) return null;

  // 简单 XML 解析（不依赖 xml2js）
  const match = containerXml.match(/full-path="([^"]+)"/);
  if (!match) return null;
  return match[1];
}

/**
 * 解析 OPF 文件
 */
function parseOpf(zip, opfPath) {
  const opfXml = readTextFromZip(zip, opfPath);
  if (!opfXml) return null;

  const opfDir = path.dirname(opfPath);

  // 提取 metadata
  const metadata = {};
  const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
  if (titleMatch) metadata.title = titleMatch[1];
  const creatorMatch = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
  if (creatorMatch) metadata.creator = creatorMatch[1];
  const langMatch = opfXml.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/);
  if (langMatch) metadata.language = langMatch[1];

  // 提取 manifest（id → href 映射）
  const manifest = {};
  const itemRegex = /<item[^>]*id="([^"]*)"[^>]*href="([^"]*)"[^>]*media-type="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = itemRegex.exec(opfXml)) !== null) {
    manifest[m[1]] = { href: m[2], mediaType: m[3] };
  }

  // 提取 spine（阅读顺序）
  const spine = [];
  const spineRegex = /<itemref[^>]*idref="([^"]*)"[^>]*\/?>/g;
  while ((m = spineRegex.exec(opfXml)) !== null) {
    const item = manifest[m[1]];
    if (item) {
      // 解析完整路径（相对于 OPF 目录）
      const href = decodeURIComponent(item.href);
      const fullPath = opfDir === '.' ? href : path.join(opfDir, href).replace(/\\/g, '/');
      spine.push({
        id: m[1],
        href: fullPath,
        mediaType: item.mediaType
      });
    }
  }

  // 如果是单个 XHTML spine（有些 EPUB 只用 nav 做 toc），尝试从 manifest 中找所有 xhtml
  if (spine.length === 0) {
    for (const [id, item] of Object.entries(manifest)) {
      if (item.mediaType.includes('xhtml') || item.mediaType.includes('html')) {
        spine.push({
          id,
          href: opfDir === '.' ? decodeURIComponent(item.href) : path.join(opfDir, decodeURIComponent(item.href)).replace(/\\/g, '/'),
          mediaType: item.mediaType
        });
      }
    }
  }

  return { metadata, manifest, spine };
}

/**
 * 获取 EPUB 结构（带缓存）
 */
function getStructure(filePath) {
  const now = Date.now();
  if (cache[filePath] && cache[filePath]._ts > now - CACHE_TTL) {
    return cache[filePath];
  }

  try {
    const zip = new AdmZip(filePath);
    const opfPath = getOpfPath(zip);
    if (!opfPath) return null;

    const parsed = parseOpf(zip, opfPath);
    if (!parsed) return null;

    const result = {
      ...parsed,
      entryNames: zip.getEntries().map(e => e.entryName),
      _ts: now
    };

    cache[filePath] = result;
    return result;
  } catch (err) {
    console.error(`[epub] parse error: ${filePath}`, err.message);
    return null;
  }
}

/**
 * 获取章节目录
 * @returns {Array} [{ id, href, title?, index }]
 */
function getToc(filePath) {
  const structure = getStructure(filePath);
  if (!structure || !structure.spine) return [];

  // 尝试从 nav / toc 获取章节标题
  const tocNcx = structure.entryNames.find(e => e.endsWith('.ncx'));
  let tocMap = {};

  if (tocNcx) {
    try {
      const zip = new AdmZip(filePath);
      const ncxXml = readTextFromZip(zip, tocNcx);
      if (ncxXml) {
        const navRegex = /<navPoint[^>]*>[\s\S]*?<text>([^<]+)<\/text>[\s\S]*?<content[^>]*src="([^"]*)"[^>]*\/?>[\s\S]*?<\/navPoint>/g;
        let nm;
        while ((nm = navRegex.exec(ncxXml)) !== null) {
          tocMap[nm[2].split('#')[0]] = nm[1];
        }
      }
    } catch {}
  }

  return structure.spine.map((item, index) => ({
    ...item,
    index,
    title: tocMap[item.href] || `第 ${index + 1} 章`
  }));
}

/**
 * 获取单章 HTML 内容（URL 已重写）
 * @param {string} filePath - EPUB 文件路径
 * @param {number} chapterIndex - 章节索引
 * @param {string} apiBase - API 基础路径，用于重写资源 URL（如 /api/comic/abc123/epub/resource）
 */
function getChapter(filePath, chapterIndex, apiBase) {
  const structure = getStructure(filePath);
  if (!structure || !structure.spine) return null;

  const chapter = structure.spine[chapterIndex];
  if (!chapter) return null;

  try {
    const zip = new AdmZip(filePath);

    // 尝试多种路径变体
    let html = readTextFromZip(zip, chapter.href);
    if (!html) {
      // 尝试 URL decode
      const altPath = decodeURIComponent(chapter.href);
      html = readTextFromZip(zip, altPath);
    }
    if (!html) {
      // 搜索包含该文件名的条目
      const name = path.basename(chapter.href);
      const match = structure.entryNames.find(e => e.endsWith(name));
      if (match) html = readTextFromZip(zip, match);
    }

    if (!html) return null;

    // 重写资源 URL 为 API 路径
    if (apiBase) {
      // 计算当前章节目录
      let chapterDir = path.dirname(chapter.href);
      if (chapterDir === '.' || chapterDir === '') chapterDir = '';

      // 重写相对路径 src/href: src="images/xxx.jpg" → src="/api/comic/x/epub/resource/OEBPS/images/xxx.jpg"
      html = html.replace(/(src|href)=["'](?!https?:\/\/|\/|#|data:)([^"']+)["']/gi, (match, attr, url) => {
        const resolved = chapterDir ? path.join(chapterDir, url).replace(/\\/g, '/') : url;
        return `${attr}="${apiBase}/${encodeURI(resolved)}"`;
      });

      // 重写 CSS url(): url(../images/xxx.jpg) → url(/api/comic/x/epub/resource/OEBPS/images/xxx.jpg)
      html = html.replace(/url\(["']?(?!https?:\/\/|\/|data:)([^"')]+)["']?\)/gi, (match, url) => {
        const resolved = chapterDir ? path.join(chapterDir, url).replace(/\\/g, '/') : url;
        return `url("${apiBase}/${encodeURI(resolved)}")`;
      });
    }

    // 注入基础样式 + 字体控制
    const baseStyles = `
      <style id="epub-base-style">
        body {
          font-family: "Iowan Old Style", "Noto Serif SC", "Source Han Serif SC", Georgia, serif;
          font-size: 18px;
          line-height: 1.8;
          color: #e8e8ec;
          background: #1a1a22;
          padding: 16px 24px;
          max-width: 720px;
          margin: 0 auto;
          transition: font-size 0.2s, line-height 0.2s, background 0.3s, color 0.3s;
          word-break: break-word;
        }
        img { max-width: 100%; height: auto; margin: 12px 0; border-radius: 4px; }
        h1, h2, h3, h4 { color: #f0f0f5; margin: 1.2em 0 0.6em; line-height: 1.4; }
        p { margin: 0.8em 0; }
        a { color: #5e5ce6; }
        hr { border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 1.5em 0; }
        blockquote {
          border-left: 3px solid rgba(94,92,230,0.4);
          margin: 1em 0; padding: 0.5em 1em; color: #b0b0ba;
        }
        .epub-brightness-overlay {
          position: fixed; inset: 0; pointer-events: none; z-index: 9999;
          background: rgba(0,0,0,0); transition: background 0.3s;
        }
      </style>
      <div class="epub-brightness-overlay" id="epubOverlay"></div>
      <script>
        window.addEventListener('message', function(e) {
          if (!e.data || !e.data.type) return;
          var body = document.body;
          var style = document.getElementById('epub-base-style');
          switch(e.data.type) {
            case 'fontSize':
              body.style.fontSize = e.data.value + 'px';
              break;
            case 'lineHeight':
              body.style.lineHeight = e.data.value;
              break;
            case 'fontFamily':
              body.style.fontFamily = e.data.value;
              break;
            case 'theme':
              if (e.data.value === 'dark') {
                body.style.background = '#1a1a22'; body.style.color = '#e8e8ec';
              } else if (e.data.value === 'sepia') {
                body.style.background = '#f4ecd8'; body.style.color = '#3a3226';
              } else if (e.data.value === 'light') {
                body.style.background = '#ffffff'; body.style.color = '#1c1c1e';
              }
              break;
            case 'brightness':
              var overlay = document.getElementById('epubOverlay');
              if (overlay) overlay.style.background = 'rgba(0,0,0,' + (1 - e.data.value) + ')';
              break;
          }
        });
      <\/script>
    `;

    // 注入样式到 <head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', baseStyles + '</head>');
    } else if (html.includes('<body')) {
      html = html.replace('<body', baseStyles + '<body');
    } else {
      html = baseStyles + html;
    }

    return html;
  } catch (err) {
    console.error(`[epub] chapter read error: ${filePath}#${chapterIndex}`, err.message);
    return null;
  }
}

/**
 * 获取 EPUB 资源文件（图片/CSS/字体等）
 */
function getResource(filePath, resourcePath) {
  try {
    const zip = new AdmZip(filePath);

    // 尝试直接读取
    let buffer = null;
    try { buffer = zip.readFile(resourcePath); } catch {}

    // 尝试 URL decode
    if (!buffer) {
      try { buffer = zip.readFile(decodeURIComponent(resourcePath)); } catch {}
    }

    // 按文件名搜索
    if (!buffer) {
      const structure = getStructure(filePath);
      if (structure) {
        const name = path.basename(resourcePath);
        const match = structure.entryNames.find(e => e.endsWith(name));
        if (match) {
          try { buffer = zip.readFile(match); } catch {}
        }
      }
    }

    return buffer;
  } catch {
    return null;
  }
}

/**
 * 清除缓存
 */
function clearCache(filePath) {
  if (filePath) {
    delete cache[filePath];
  } else {
    cache = {};
  }
}

module.exports = { getStructure, getToc, getChapter, getResource, clearCache };
