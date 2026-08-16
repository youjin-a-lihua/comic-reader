'use strict';
/**
 * 在线源注册表（可插拔、多源、默认全关）
 *
 * 一个「在线源」实现以下统一接口（见 lib/sources/jm.js 作为示例）：
 *   search(keyword, order, page) -> { total, maxPage, comics:[{id,title,author,cover,tags,description}] }
 *   album(id)                    -> { id, title, author, cover, description, likes, tags, chapters:[{id,title}], related }
 *   chapter(epId)               -> { epId, images:[url...] }
 *   getCoverUrl(id) / getImageUrl(epId, name)   (可选)
 *   decodeImage(buffer, parsed)  -> Promise<Buffer>  把拉到的原始图还原为可显示图；无操作则返回原 buffer
 *   parseImageUrl(u)             -> parsed | null     该源是否认得这个图片 URL（图片代理据此路由）
 *
 * 源清单：lib/sources/sources.json（列出所有可用源 + 元信息）。新增源只需在清单里加一项，
 * 并在 lib/sources/ 下提供对应实现文件，无需改动 server.js。
 *
 * 启用的源由 ONLINE_SOURCE 决定：
 *   - 不设置                           → 仅启用 enabledByDefault:true 的源（当前无，即默认全关）
 *   - ONLINE_SOURCE=jm                → 仅启用 jm
 *   - ONLINE_SOURCE=jm,kavita         → 启用多个（逗号/空格分隔）
 *   - ONLINE_SOURCE=all               → 启用清单里全部
 *
 * 仓库内置 jm 作为示例，但默认不打开，完全由部署者自行决定开启哪一个（「可插拔源」+ 合规姿态）。
 */
const fs = require('fs');
const path = require('path');

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf8'));
  } catch (e) {
    console.error('[sources] 读取 sources.json 失败：', e.message);
    return [];
  }
}

const manifest = loadManifest();
const registry = {}; // key -> { key, name, file, description, enabledByDefault, impl }

for (const item of manifest) {
  const key = (item.key || (item.file || '').replace(/\.js$/, '')).toLowerCase();
  if (!key) continue;
  try {
    const impl = require(path.join(__dirname, item.file));
    registry[key] = {
      key,
      name: item.name || impl.label || impl.name || key,
      file: item.file,
      description: item.description || '',
      enabledByDefault: !!item.enabledByDefault,
      impl,
    };
  } catch (e) {
    console.error(`[sources] 加载源 ${key} 失败：`, e.message);
  }
}

function resolveEnabled() {
  const env = (process.env.ONLINE_SOURCE || '').trim().toLowerCase();
  const keys = Object.keys(registry);
  if (env) {
    if (env === 'all') return new Set(keys);
    return new Set(env.split(/[,\s]+/).filter(Boolean));
  }
  return new Set(keys.filter(k => registry[k].enabledByDefault));
}
const enabledSet = resolveEnabled();

function getEnabled() {
  return Object.keys(registry).filter(k => enabledSet.has(k)).map(k => registry[k]);
}

function getSource(key) {
  return registry[(key || '').toLowerCase()] ? registry[(key || '').toLowerCase()].impl : null;
}

function getSourceMeta(key) {
  return registry[(key || '').toLowerCase()] || null;
}

function isEnabled() {
  return getEnabled().length > 0;
}

// 向后兼容：返回首个启用的源（老的单源调用可用）
function getActiveSource() {
  const e = getEnabled();
  return e.length ? e[0].impl : null;
}

function getActiveName() {
  const e = getEnabled();
  return e.length ? e[0].key : null;
}

function listSources() {
  return Object.keys(registry).map(k => ({
    key: k,
    name: registry[k].name,
    description: registry[k].description,
    enabled: enabledSet.has(k),
  }));
}

// 图片代理路由：用各启用源的 parseImageUrl 识别归属，匹配者即解码者；否则退回首个启用源
function findDecoder(u) {
  const enabled = getEnabled();
  for (const s of enabled) {
    try {
      if (typeof s.impl.parseImageUrl === 'function' && s.impl.parseImageUrl(u)) return s.impl;
    } catch (_) { /* 忽略解析异常，继续尝试下一个源 */ }
  }
  return enabled.length ? enabled[0].impl : null;
}

module.exports = {
  getEnabled, getSource, getSourceMeta, isEnabled,
  getActiveSource, getActiveName, listSources, findDecoder, registry,
};
