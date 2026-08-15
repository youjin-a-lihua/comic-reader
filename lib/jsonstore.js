/**
 * 原子 JSON 存储
 *
 * 修复：原代码在每个路由里直接 readFileSync + writeFileSync 操作
 * progress.json / views.json / likes.json。并发写入时会出现：
 *   1. 写到一半进程被 kill → 文件截断 → JSON.parse 抛错 → 数据全丢
 *   2. 读-改-写竞态 → 后写的覆盖先写的
 *
 * 方案：内存缓存 + 写临时文件后 rename（POSIX 下 rename 是原子的）+ 写合并（debounce）
 */

const fs = require('fs');
const path = require('path');

const stores = new Map();

class JsonStore {
  constructor(file, defaultValue = {}) {
    this.file = file;
    this.defaultValue = defaultValue;
    this.data = null;
    this.dirty = false;
    this.timer = null;
    this.flushDelay = 400; // 写合并窗口
  }

  _ensureDir() {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  read() {
    if (this.data !== null) return this.data;
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 文件损坏：备份后重置，而不是静默丢数据
        try {
          const bak = `${this.file}.corrupt-${Date.now()}`;
          fs.copyFileSync(this.file, bak);
          console.error(`[jsonstore] ${this.file} 解析失败，已备份到 ${bak}`);
        } catch {}
      }
      this.data = JSON.parse(JSON.stringify(this.defaultValue));
    }
    return this.data;
  }

  /** 修改数据后调用，异步合并写盘 */
  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelay);
    if (this.timer.unref) this.timer.unref();
  }

  /** 立即同步写盘（原子） */
  flush() {
    if (!this.dirty || this.data === null) return;
    try {
      this._ensureDir();
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error(`[jsonstore] 写入失败 ${this.file}:`, err.message);
    }
  }

  /** 读-改-写一体，保证不丢中间态 */
  update(fn) {
    const data = this.read();
    const result = fn(data);
    this.markDirty();
    return result;
  }

  /** 整体替换（用于列表类数据的过滤/重排），立即落盘 */
  set(value) {
    this.data = value;
    this.dirty = true;
    this.flush();
    return this.data;
  }
}

function getStore(file, defaultValue = {}) {
  if (!stores.has(file)) stores.set(file, new JsonStore(file, defaultValue));
  return stores.get(file);
}

/** 进程退出前把所有脏数据落盘 */
function flushAll() {
  for (const s of stores.values()) s.flush();
}

let hooked = false;
function installExitHooks() {
  if (hooked) return;
  hooked = true;
  const bye = (code) => { flushAll(); process.exit(code); };
  process.on('exit', flushAll);
  process.on('SIGINT', () => bye(0));
  process.on('SIGTERM', () => bye(0));
}

module.exports = { getStore, flushAll, installExitHooks };
