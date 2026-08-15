/**
 * 阅读进度持久化模块
 * 按用户隔离，JSON 文件存储（原子写 + 写合并）
 * 结构: { [username]: { [comicId]: { page, totalPages, updatedAt, bookmarked } } }
 *
 * 修复要点（v2）：
 *  - 原来每次 read/write 都是 readFileSync + writeFileSync，
 *    多用户并发翻页时会互相覆盖，丢进度；且写到一半断电会写出半截 JSON。
 *  - 现改为 JsonStore：内存缓存 + debounce 合并写 + tmp+rename 原子落盘。
 */

const path = require('path');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

const store = getStore(PROGRESS_FILE, {});

/** 读取全部进度数据（返回的是内存引用的浅层副本，勿直接改） */
function readAll() {
  return store.read();
}

/** 立即落盘（进程退出前调用） */
function flush() {
  store.flush();
}

/** 获取用户的进度映射 */
function getUserProgress(username) {
  const all = store.read();
  return all[username] || {};
}

/** 保存单本漫画进度 */
function saveProgress(username, comicId, page, totalPages) {
  let entry = null;
  store.update(all => {
    if (!all[username]) all[username] = {};
    entry = {
      ...(all[username][comicId] || {}),
      page,
      totalPages,
      updatedAt: new Date().toISOString()
    };
    all[username][comicId] = entry;
  });
  return entry;
}

/** 切换收藏状态 */
function toggleBookmark(username, comicId) {
  let entry = null;
  store.update(all => {
    if (!all[username]) all[username] = {};
    entry = { ...(all[username][comicId] || {}) };
    entry.bookmarked = !entry.bookmarked;
    if (!entry.updatedAt) entry.updatedAt = new Date().toISOString();
    all[username][comicId] = entry;
  });
  return entry;
}

/** 获取继续阅读列表（最近更新的前 20 本） */
function getContinueReading(username) {
  const progress = getUserProgress(username);
  return Object.entries(progress)
    .filter(([, v]) => v && v.page > 0 && v.page < (v.totalPages || 99999))
    .sort((a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0))
    .slice(0, 20)
    .map(([id, v]) => ({ id, ...v }));
}

/** 获取收藏列表 */
function getBookmarks(username) {
  const progress = getUserProgress(username);
  return Object.entries(progress)
    .filter(([, v]) => v && v.bookmarked)
    .map(([id, v]) => ({ id, ...v }));
}

/** 删除某本漫画在所有用户进度/收藏里的记录 */
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
