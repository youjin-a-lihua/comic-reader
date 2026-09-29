'use strict';
// Registry of pluggable online sources; everything is off unless ONLINE_SOURCE says otherwise.
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
const registry = {};

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

// Route by URL: the source that recognises an image URL is the one that decodes it.
function findDecoder(u) {
  const enabled = getEnabled();
  for (const s of enabled) {
    try {
      if (typeof s.impl.parseImageUrl === 'function' && s.impl.parseImageUrl(u)) return s.impl;
    } catch (_) {  }
  }
  return enabled.length ? enabled[0].impl : null;
}

module.exports = {
  getEnabled, getSource, getSourceMeta, isEnabled,
  getActiveSource, getActiveName, listSources, findDecoder, registry,
};
