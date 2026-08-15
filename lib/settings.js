/**
 * 全局设置（持久化到 DATA_DIR/settings.json，原子写）
 *
 * 自动解密相关配置：
 *   autoDecrypt     是否开启自动解密（默认 false，尊重用户选择）
 *   decryptPassword JM 加密 PDF 的主人/用户密码（默认 11110000）
 *   allowDeleteComic 允许管理员在书架一键删除漫画（含本体/封面/元数据），默认关闭
 *
 * 设计为「默认关闭、管理员在控制面板开启」，便于直接发布到 GitHub 供他人部署。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULTS = {
  autoDecrypt: false,
  decryptPassword: '11110000',
  allowDeleteComic: false,
};

const store = getStore(path.join(DATA_DIR, 'settings.json'), DEFAULTS);

function getSettings() {
  return Object.assign({}, DEFAULTS, store.read());
}

function saveSettings(patch) {
  const cur = store.read();
  if (typeof patch === 'object' && patch !== null) {
    if ('autoDecrypt' in patch) cur.autoDecrypt = !!patch.autoDecrypt;
    if ('decryptPassword' in patch && patch.decryptPassword) {
      cur.decryptPassword = String(patch.decryptPassword);
    }
    if ('allowDeleteComic' in patch) cur.allowDeleteComic = !!patch.allowDeleteComic;
  }
  store.flush();
  return Object.assign({}, DEFAULTS, cur);
}

module.exports = { getSettings, saveSettings, DEFAULTS };
