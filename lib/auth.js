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
  if (!user.passwordHash || user.passwordHash.startsWith('$scrypt$')) return;
  user.passwordHash = hashPassword(password);
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// users.json is written tmp+rename; a crash mid-write would otherwise lose every account.
function saveUsers(users) {
  getStore(USERS_FILE, []).set(users);
}

function authenticate(username, password) {
  ensureDataDir();
  const users = getUsers();
  // On first run the first account to log in becomes the administrator.
  if (users.length === 0) {
    const admin = {
      username,
      passwordHash: hashPassword(password),
      role: 'admin',
      createdAt: new Date().toISOString(),
    };
    saveUsers([admin]);
    return { success: true, username, role: 'admin' };
  }
  const user = users.find(u => u.username === username);
  if (!user) return { success: false, error: '用户名或密码错误' };
  if (!verifyPassword(password, user.passwordHash)) {
    return { success: false, error: '用户名或密码错误' };
  }
  maybeUpgrade(user, password);
  saveUsers(users);
  return { success: true, username: user.username, role: user.role };
}

function changePassword(username, oldPassword, newPassword) {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return false;
  if (!verifyPassword(oldPassword, user.passwordHash)) return false;
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  return true;
}

function listUsers() {
  return getUsers().map(u => ({ username: u.username, role: u.role }));
}

function addUser(username, password) {
  const users = getUsers();
  if (users.find(u => u.username === username)) {
    return { success: false, error: '用户已存在' };
  }
  users.push({ username, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() });
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
  user.role = role;
  saveUsers(users);
  return { success: true };
}

module.exports = { authenticate, changePassword, listUsers, addUser, removeUser, resetPassword, setRole };
