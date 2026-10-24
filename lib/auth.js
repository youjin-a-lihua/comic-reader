// Local accounts. Passwords use scrypt; legacy SHA-256 hashes are upgraded on login.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (stored.startsWith('$scrypt$')) {
    const parts = stored.split('$');
    if (parts.length < 4) return false;
    const salt = parts[2];
    const expected = parts[3];
    try {
      const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
    } catch {
      return false;
    }
  }
  try {
    const legacy = crypto.createHash('sha256').update('fn-comic:' + password).digest('hex');
    if (typeof stored === 'string' && /^[0-9a-f]{64}$/i.test(stored)) {
      return crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
    }
  } catch {
    return false;
  }
  return false;
}

function maybeUpgrade(user, password) {
  if (!user.passwordHash || user.passwordHash.startsWith('$scrypt$')) return false;
  user.passwordHash = hashPassword(password);
  return true;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

const USERNAME_RE = /^[\w.@-]{1,64}$/;

// Returns { users, status } where status is 'ok' | 'missing' | 'corrupt'.
// Treating a corrupt file as "no users" used to hand administrator rights to
// whoever happened to log in first.
function loadUsers() {
  let raw;
  try {
    raw = fs.readFileSync(USERS_FILE, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { users: [], status: 'missing' };
    return { users: [], status: 'corrupt' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { users: [], status: 'corrupt' };
    return { users: parsed, status: 'ok' };
  } catch {
    return { users: [], status: 'corrupt' };
  }
}

function getUsers() {
  const { users } = loadUsers();
  return users;
}

// users.json is written tmp+rename; a crash mid-write would otherwise lose every account.
function saveUsers(users) {
  getStore(USERS_FILE, []).set(users);
}

// A fixed dummy hash so that unknown usernames cost the same as known ones.
const DUMMY_HASH = hashPassword('comic-reader-dummy-password');

function authenticate(username, password) {
  ensureDataDir();
  const { users, status } = loadUsers();
  if (status === 'corrupt') {
    console.error('[auth] users.json 损坏或不可读，已拒绝本次登录；请从 DATA_DIR 下的 .corrupt-* 备份恢复');
    return { success: false, error: '账号数据损坏，登录已拒绝。请检查 DATA_DIR/users.json' };
  }
// On first run the first account to log in becomes the administrator.
  if (users.length === 0) {
    if (!USERNAME_RE.test(String(username || ''))) {
      return { success: false, error: '用户名只能包含字母、数字、._-@，长度 1-64' };
    }
    const admin = {
      username,
      passwordHash: hashPassword(password),
      role: 'admin',
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
    };
    saveUsers([admin]);
    return { success: true, username, role: 'admin' };
  }
  const user = users.find(u => u.username === username);
  if (!user) {
    verifyPassword(password, DUMMY_HASH);
    return { success: false, error: '用户名或密码错误' };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { success: false, error: '用户名或密码错误' };
  }
  if (maybeUpgrade(user, password)) saveUsers(users);
  return { success: true, username: user.username, role: user.role };
}

function changePassword(username, oldPassword, newPassword) {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return false;
  if (!verifyPassword(oldPassword, user.passwordHash)) return false;
  user.passwordHash = hashPassword(newPassword);
  user.tokenVersion = (user.tokenVersion || 1) + 1;
  saveUsers(users);
  return true;
}

// Cached lookup for the request path; the store is refreshed whenever this
// process writes users.json, and re-read on mtime change otherwise.
let _userCache = null;
let _userCacheAt = 0;
function findUser(username) {
  if (typeof username !== 'string' || !username) return null;
  let mtime = 0;
  try { mtime = fs.statSync(USERS_FILE).mtimeMs; } catch { _userCache = null; return null; }
  if (!_userCache || mtime !== _userCacheAt) {
    _userCache = new Map(getUsers().map(u => [u.username, u]));
    _userCacheAt = mtime;
  }
  return _userCache.get(username) || null;
}

function listUsers() {
  return getUsers().map(u => ({ username: u.username, role: u.role }));
}

function addUser(username, password) {
  if (!USERNAME_RE.test(String(username || ''))) {
    return { success: false, error: '用户名只能包含字母、数字、._-@，长度 1-64' };
  }
  const users = getUsers();
  if (users.find(u => u.username === username)) {
    return { success: false, error: '用户已存在' };
  }
  users.push({ username, passwordHash: hashPassword(password), role: 'user', tokenVersion: 1, createdAt: new Date().toISOString() });
  saveUsers(users);
  return { success: true };
}

function removeUser(username) {
  const users = getUsers();
  const idx = users.findIndex(u => u.username === username);
  if (idx === -1) return { success: false, error: '用户不存在' };
  if (users[idx].role === 'admin' && users.filter(u => u.role === 'admin').length === 1) {
    return { success: false, error: '不能删除最后一个管理员' };
  }
  users.splice(idx, 1);
  saveUsers(users);
  return { success: true };
}

function resetPassword(username, newPassword) {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (user) user.tokenVersion = (user.tokenVersion || 1) + 1;
  if (!user) return { success: false, error: '用户不存在' };
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  return { success: true };
}

function setRole(username, role) {
  if (!['admin', 'user'].includes(role)) return { success: false, error: '角色必须为 admin 或 user' };
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return { success: false, error: '用户不存在' };
  if (user.role === 'admin' && role !== 'admin' && users.filter(u => u.role === 'admin').length === 1) {
    return { success: false, error: '不能取消最后一个管理员' };
  }
  if (user.role !== role) user.tokenVersion = (user.tokenVersion || 1) + 1;
  user.role = role;
  saveUsers(users);
  return { success: true };
}

module.exports = { authenticate, changePassword, listUsers, addUser, removeUser, resetPassword, setRole, findUser };
