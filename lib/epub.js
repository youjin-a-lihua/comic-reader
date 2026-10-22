// EPUB parser. An EPUB is a ZIP: META-INF/container.xml -> .opf -> manifest + spine.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

let cache = {};
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 64;            // 条目上限，防止翻几百本后内存只增不减

// ── zip 句柄缓存 ─────────────────────────────────────
// AdmZip 的构造函数对字符串路径会 fs.readFileSync 整包，而下面 4 个函数原来各自
// new AdmZip(filePath)：等于「每进一章、每加载一张插图都重读整本书」。
// 实测 132MB 的 EPUB：getChapter 63ms / getResource ×10 677ms，全是重复读；
// 缓存句柄后这些降到个位数毫秒。
// 用总字节数上界而不是条数上界 —— 一本 132MB 就够吃掉几百 MB 内存。
const ZIP_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const zipCache = new Map();   // filePath -> { zip, mtimeMs, size }

function getZip(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch { return null; }

  const hit = zipCache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs) {
    zipCache.delete(filePath);          // LRU：命中后移到队尾
    zipCache.set(filePath, hit);
    return hit.zip;
  }

  let zip;
  try {
    zip = new AdmZip(filePath);
  } catch (e) {
    console.error(`[epub] 打开失败: ${filePath}`, e.message);
    return null;
  }
  zipCache.set(filePath, { zip, mtimeMs: st.mtimeMs, size: st.size });
  evictZips();
  return zip;
}

function evictZips() {
  let total = 0;
  for (const v of zipCache.values()) total += v.size;
  while (zipCache.size > 1 && total > ZIP_CACHE_MAX_BYTES) {
    const [k, v] = zipCache.entries().next().value;   // 最旧的一条
    zipCache.delete(k);
    total -= v.size;
  }
}

/** 解析 XML 标签上的属性（顺序无关，双/单引号都认） */
function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    if (m[1] !== undefined) attrs[m[1].toLowerCase()] = m[2];
    else attrs[m[3].toLowerCase()] = m[4];
  }
  return attrs;
}

/**
 * 解析 manifest 的 <item> 列表。
 * 不能用「id 在前、href 居中、media-type 在后」的整段正则 —— OPF 的属性顺序是自由的，
 * 实测 79 本小说里有 23 本把 href 写在 id 前面，旧正则命中 0 条 → manifest 为空
 * → spine 为空 → 章节列表整本空白（占 29%，一直以为「文件坏了」）。
 */
function parseManifestItems(opfXml) {
  const items = [];
  const re = /<item\b[^>]*>/gi;
  let m;
  while ((m = re.exec(opfXml)) !== null) {
    const it = parseAttrs(m[0]);
    if (it.id && it.href) items.push(it);
  }
  return items;
}

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

  // 按属性名取，避免被单引号/属性顺序坑到
  const tag = containerXml.match(/<rootfile\b[^>]*>/i);
  if (tag) {
    const a = parseAttrs(tag[0]);
    if (a['full-path']) return a['full-path'];
  }
  const match = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
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
  for (const it of parseManifestItems(opfXml)) {
    manifest[it.id] = { href: it.href, mediaType: it['media-type'] || '' };
  }

  const spine = [];
  const itemrefRe = /<itemref\b[^>]*>/gi;
  let m;
  while ((m = itemrefRe.exec(opfXml)) !== null) {
    const idref = parseAttrs(m[0]).idref;
    if (!idref) continue;
    const item = manifest[idref];
    if (item) {
      const href = decodeURIComponent(item.href);
      const fullPath = opfDir === '.' ? href : path.join(opfDir, href).replace(/\\/g, '/');
      spine.push({
        id: idref,
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
    const zip = getZip(filePath);
    if (!zip) return null;
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
    pruneStructureCache();
    return result;
  } catch (err) {
    console.error(`[epub] parse error: ${filePath}`, err.message);
    return null;
  }
}

// 结构缓存原来只有「读时判 TTL」，条目永不过期 —— 访问过多少本小说就留多少条。
function pruneStructureCache() {
  const keys = Object.keys(cache);
  if (keys.length <= CACHE_MAX) return;
  const now = Date.now();
  for (const k of keys) {
    if (now - (cache[k]._ts || 0) > CACHE_TTL) delete cache[k];
  }
  const rest = Object.keys(cache);
  for (let i = 0; i < rest.length - CACHE_MAX; i++) delete cache[rest[i]];
}

function getToc(filePath) {
  const structure = getStructure(filePath);
  if (!structure || !structure.spine) return [];

  const tocNcx = structure.entryNames.find(e => e.endsWith('.ncx'));
  let tocMap = {};

  if (tocNcx) {
    try {
      const zip = getZip(filePath);
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
    const zip = getZip(filePath);

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
    const zip = getZip(filePath);

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
    zipCache.delete(filePath);
  } else {
    cache = {};
    zipCache.clear();
  }
}

module.exports = { getStructure, getToc, getChapter, getResource, clearCache };
