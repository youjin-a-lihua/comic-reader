'use strict';
/**
 * 在线源注册表
 *
 * 一个「在线源」实现以下统一接口（见 lib/sources/jm.js 作为示例）：
 *   search(keyword, order, page) -> { total, maxPage, comics:[{id,title,author,cover,tags,description}] }
 *   album(id)                    -> { id, title, author, cover, description, likes, tags, chapters:[{id,title}], related }
 *   chapter(epId)               -> { epId, images:[url...] }
 *   getCoverUrl(id) / getImageUrl(epId, name)   (可选)
 *   decodeImage(buffer, parsed)  -> Promise<Buffer>  把拉到的原始图还原为可显示图；无操作则返回原 buffer
 *   imageUrlMatches(parsed)      -> bool             该源是否认得这个图片 URL（代理路由用，可选）
 *
 * 默认不启用任何在线源：ONLINE_SOURCE 留空即关闭。需手动在环境变量中设置
 * ONLINE_SOURCE=jm 才会注册并启用对应源。仓库内置 jm 作为示例，但默认不打开，
 * 完全由部署者自行决定开启哪一个、或是否开启（「可插拔源」设计）。
 *
 * 切换源：设置 ONLINE_SOURCE=jm。新增源：在 lib/sources/ 下加一个实现该接口的文件，
 * 并在下方 registerSource 注册即可，无需改动 server.js。
 */
const sources = {};

function registerSource(name, impl) {
  sources[name.toLowerCase()] = impl;
}

let _resolved = false;
let _activeName = null;
let _activeSource = null;

// 读取 ONLINE_SOURCE，首次调用时解析一次（环境变量在启动时即固定）
function resolve() {
  if (_resolved) return;
  _resolved = true;
  const requested = (process.env.ONLINE_SOURCE || '').trim().toLowerCase();
  if (!requested) {
    // 默认不注册、不启用
    _activeSource = null;
    _activeName = null;
    return;
  }
  _activeSource = sources[requested] || null;
  _activeName = _activeSource ? requested : null;
}

function getActiveSource() {
  resolve();
  return _activeSource;
}

function getActiveName() {
  resolve();
  return _activeName;
}

function isEnabled() {
  return !!getActiveSource();
}

function listSources() {
  return Object.keys(sources).map(name => ({ name, label: sources[name].label || name }));
}

// ── 注册内置源（仅当 ONLINE_SOURCE 指向时才启用）──
registerSource('jm', require('./jm'));

module.exports = { registerSource, getActiveSource, getActiveName, isEnabled, listSources, sources };
