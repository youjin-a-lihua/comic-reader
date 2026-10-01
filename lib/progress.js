// Per-user reading progress and bookmarks, stored through lib/jsonstore.

const path = require('path');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

const store = getStore(PROGRESS_FILE, {});

// The returned object is a shallow copy of cached data; do not mutate it.
function readAll() {
  return store.read();
}

function flush() {
  store.flush();
}

function getUserProgress(username) {
  const all = store.read();
  return all[username] || {};
}

function saveProgress(username, comicId, page, totalPages, name) {
  let entry = null;
  store.update(all => {
    if (!all[username]) all[username] = {};
    entry = {
      ...(all[username][comicId] || {}),
      page,
      totalPages,
      updatedAt: new Date().toISOString()
    };
    // Keep the title so a record stays readable after the comic leaves the scan.
    if (name) entry.name = name;
    all[username][comicId] = entry;
  });
  return entry;
}

function toggleBookmark(username, comicId, name) {
  let entry = null;
  store.update(all => {
    if (!all[username]) all[username] = {};
    entry = { ...(all[username][comicId] || {}) };
    entry.bookmarked = !entry.bookmarked;
    if (!entry.updatedAt) entry.updatedAt = new Date().toISOString();
    if (name) entry.name = name;
    all[username][comicId] = entry;
  });
  return entry;
}

function getContinueReading(username) {
  const progress = getUserProgress(username);
  return Object.entries(progress)
    .filter(([, v]) => v && v.page > 0 && v.page < (v.totalPages || 99999))
    .sort((a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0))
    .slice(0, 20)
    .map(([id, v]) => ({ id, ...v }));
}

function getBookmarks(username) {
  const progress = getUserProgress(username);
  return Object.entries(progress)
    .filter(([, v]) => v && v.bookmarked)
    .map(([id, v]) => ({ id, ...v }));
}

function removeComicFromAllUsers(comicId) {
  store.update(all => {
    for (const user of Object.keys(all)) {
      if (all[user] && comicId in all[user]) {
        delete all[user][comicId];
      }
    }
  });
}

module.exports = {
  getUserProgress,
  saveProgress,
  toggleBookmark,
  getContinueReading,
  getBookmarks,
  removeComicFromAllUsers,
  readAll,
  flush,
  PROGRESS_FILE
};
