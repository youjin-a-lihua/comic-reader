/**
 * 漫画阅读器 — 内置认证模块
 * 首次运行（users.json 为空）时，第一个登录的账号自动成为管理员。
 * 密码使用 scrypt（随机盐）存储，兼容旧版 SHA-256 哈希。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// scrypt 配置
const SCRYPT_KEYLEN = 64;

/** 生成 scrypt 哈希（格式: $scrypt$<salt_hex>$<hash_hex>） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

/** 验证密码，兼容旧版 SHA-256 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  // 新格式: $scrypt$<salt>$<hash>
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
  // 旧格式: 纯 SHA-256 hex（向后兼容）
  const legacy = crypto.createHash('sha256').update('fn-comic:' + password).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(stored));
}

/** 自动升级旧哈希 → scrypt */
function maybeUpgrade(user, password) {
  if (!user.passwordHash || user.passwordHash.startsWith('$scrypt$')) return;
  user.passwordHash = hashPassword(password);
}

// 确保数据目录存在（不预置任何账号）
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// 读取用户列表
function getUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// 保存用户列表
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

// 认证
function authenticate(username, password) {
  ensureDataDir();
  const users = getUsers();
  // 首次运行：任意账号密码即成为管理员（第一个注册者拥有最高权限）
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
  // 自动升级旧哈希
  maybeUpgrade(user, password);
  saveUsers(users);
  return { success: true, username: user.username, role: user.role };
}

// 修改密码
function changePassword(username, oldPassword, newPassword) {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return false;
  if (!verifyPassword(oldPassword, user.passwordHash)) return false;
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  return true;
}

// 列出用户
function listUsers() {
  return getUsers().map(u => ({ username: u.username, role: u.role }));
}

// 添加用户
function addUser(username, password) {
  const users = getUsers();
  if (users.find(u => u.username === username)) {
    return { success: false, error: '用户已存在' };
  }
  users.push({ username, passwordHash: hashPassword(password), role: 'user', createdAt: new Date().toISOString() });
  saveUsers(users);
  return { success: true };
}

// 删除用户
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

// 重置密码
function resetPassword(username, newPassword) {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return { success: false, error: '用户不存在' };
  user.passwordHash = hashPassword(newPassword);
  saveUsers(users);
  return { success: true };
}

// 修改角色
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
