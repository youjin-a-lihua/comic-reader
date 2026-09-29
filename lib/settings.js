// Global settings persisted to DATA_DIR/settings.json. Auto-decrypt and delete permission default to off, so a fresh deployment is safe to expose.

'use strict';

const fs = require('fs');
const path = require('path');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULTS = {
  autoDecrypt: false,
  decryptPassword: 'REDACTED',
  allowDeleteComic: false,
};

const store = getStore(path.join(DATA_DIR, 'settings.json'), DEFAULTS);

function getSettings() {
  return Object.assign({}, DEFAULTS, store.read());
}

function saveSettings(patch) {
  const cur = Object.assign({}, store.read());
  if (typeof patch === 'object' && patch !== null) {
    if ('autoDecrypt' in patch) cur.autoDecrypt = !!patch.autoDecrypt;
    if ('decryptPassword' in patch && patch.decryptPassword) {
      cur.decryptPassword = String(patch.decryptPassword);
    }
    if ('allowDeleteComic' in patch) cur.allowDeleteComic = !!patch.allowDeleteComic;
  }
  store.set(cur);
  return Object.assign({}, DEFAULTS, cur);
}

module.exports = { getSettings, saveSettings, DEFAULTS };
