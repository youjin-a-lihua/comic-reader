// EPUB parser. An EPUB is a ZIP: META-INF/container.xml -> .opf -> manifest + spine.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

let cache = {};
const CACHE_TTL = 5 * 60 * 1000;

function readTextFromZip(zip, entryName) {
  try {
    const data = zip.readFile(entryName);
    return data ? data.toString('utf-8') : null;
  } catch {
    return null;
  }
}

function getOpfPath(zip) {
  const containerXml = readTextFromZip(zip, 'META-INF/container.xml');
  if (!containerXml) return null;

  const match = containerXml.match(/full-path="([^"]+)"/);
  if (!match) return null;
  return match[1];
}

function parseOpf(zip, opfPath) {
  const opfXml = readTextFromZip(zip, opfPath);
  if (!opfXml) return null;

  const opfDir = path.dirname(opfPath);

  const metadata = {};
  const titleMatch = opfXml.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/);
  if (titleMatch) metadata.title = titleMatch[1];
  const creatorMatch = opfXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/);
  if (creatorMatch) metadata.creator = creatorMatch[1];
  const langMatch = opfXml.match(/<dc:language[^>]*>([^<]+)<\/dc:language>/);
  if (langMatch) metadata.language = langMatch[1];

  const manifest = {};
  const itemRegex = /<item[^>]*id="([^"]*)"[^>]*href="([^"]*)"[^>]*media-type="([^"]*)"[^>]*\/?>/g;
  let m;
  while ((m = itemRegex.exec(opfXml)) !== null) {
    manifest[m[1]] = { href: m[2], mediaType: m[3] };
  }

  const spine = [];
  const spineRegex = /<itemref[^>]*idref="([^"]*)"[^>]*\/?>/g;
  while ((m = spineRegex.exec(opfXml)) !== null) {
    const item = manifest[m[1]];
    if (item) {
      const href = decodeURIComponent(item.href);
      const fullPath = opfDir === '.' ? href : path.join(opfDir, href).replace(/\\/g, '/');
      spine.push({
        id: m[1],
        href: fullPath,
        mediaType: item.mediaType
      });
    }
  }

  // Some EPUBs expose a single XHTML in the spine; fall back to every XHTML in the manifest.
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

function getToc(filePath) {
  const structure = getStructure(filePath);
  if (!structure || !structure.spine) return [];

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
          const _k = nm[2].split('#')[0];
          tocMap[_k] = nm[1];
          tocMap[String(_k).replace(/^.*\//, '')] = nm[1]; // spine.href may carry a directory prefix such as "OEBPS/".
        }
      }
    } catch {}
  }

  return structure.spine.map((item, index) => ({
    ...item,
    index,
    title: tocMap[item.href] || tocMap[String(item.href).replace(/^.*\//, '')] || `第 ${index + 1} 章`
  }));
}

function getChapter(filePath, chapterIndex, apiBase) {
  const structure = getStructure(filePath);
  if (!structure || !structure.spine) return null;

  const chapter = structure.spine[chapterIndex];
  if (!chapter) return null;

  try {
    const zip = new AdmZip(filePath);

    let html = readTextFromZip(zip, chapter.href);
    if (!html) {
      const altPath = decodeURIComponent(chapter.href);
      html = readTextFromZip(zip, altPath);
    }
    if (!html) {
      const name = path.basename(chapter.href);
      const match = structure.entryNames.find(e => e.endsWith(name));
      if (match) html = readTextFromZip(zip, match);
    }

    if (!html) return null;

    if (apiBase) {
      let chapterDir = path.dirname(chapter.href);
      if (chapterDir === '.' || chapterDir === '') chapterDir = '';

      // Rewrite src/href and CSS url() to absolute API paths so the sandboxed iframe can load them.
      html = html.replace(/(src|href)=["'](?!https?:\/\/|\/|#|data:)([^"']+)["']/gi, (match, attr, url) => {
        const resolved = chapterDir ? path.join(chapterDir, url).replace(/\\/g, '/') : url;
        return `${attr}="${apiBase}/${encodeURI(resolved)}"`;
      });

      html = html.replace(/url\(["']?(?!https?:\/\/|\/|data:)([^"')]+)["']?\)/gi, (match, url) => {
        const resolved = chapterDir ? path.join(chapterDir, url).replace(/\\/g, '/') : url;
        return `url("${apiBase}/${encodeURI(resolved)}")`;
      });
    }

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

function getResource(filePath, resourcePath) {
  try {
    const zip = new AdmZip(filePath);

    let buffer = null;
    try { buffer = zip.readFile(resourcePath); } catch {}

    if (!buffer) {
      try { buffer = zip.readFile(decodeURIComponent(resourcePath)); } catch {}
    }

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

function clearCache(filePath) {
  if (filePath) {
    delete cache[filePath];
  } else {
    cache = {};
  }
}

module.exports = { getStructure, getToc, getChapter, getResource, clearCache };
