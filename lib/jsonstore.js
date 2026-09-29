// Atomic JSON store: memory cache, debounced writes, tmp+rename on flush.

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
    this.flushDelay = 400;
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
        // A corrupt file is backed up and reset, not silently discarded.
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

  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushDelay);
    if (this.timer.unref) this.timer.unref();
  }

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
      // Retrying is safe because markDirty already defers by 400ms.
      this.timer = null;
      this.markDirty();
    }
  }

  update(fn) {
    const data = this.read();
    const result = fn(data);
    this.markDirty();
    return result;
  }

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
