// Global settings persisted to DATA_DIR/settings.json. Auto-decrypt and delete permission default to off, so a fresh deployment is safe to expose.

'use strict';

const fs = require('fs');
const path = require('path');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// The decrypt password is never baked in: it comes from the admin page
// (DATA_DIR/settings.json) or DECRYPT_PASSWORD. Empty means auto-decrypt stays idle.
const DEFAULTS = {
  autoDecrypt: false,
  decryptPassword: process.env.DECRYPT_PASSWORD || '',
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
    } else if (patch.clearDecryptPassword === true) {
      cur.decryptPassword = '';
    }
    if ('allowDeleteComic' in patch) cur.allowDeleteComic = !!patch.allowDeleteComic;
  }
  store.set(cur);
  return Object.assign({}, DEFAULTS, cur);
}

module.exports = { getSettings, saveSettings, DEFAULTS };
