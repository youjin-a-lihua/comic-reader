'use strict';
// Admin audit log, appended as JSONL: one corrupt line costs one entry, not the file.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = 5 * 1024 * 1024; // Rotate at 5MB, keeping one previous file.
const RING_SIZE = 500;

let ring = [];
let writeQueue = Promise.resolve(); // Serialise appends so concurrent writes cannot interleave.
let dropped = 0;

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {  }
}

function clientIp(req) {
  if (!req) return '';
  const xff = (req.headers && req.headers['x-forwarded-for']) || '';
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

function record(entry) {
  const rec = {
    t: new Date().toISOString(),
    user: String((entry && entry.user) || 'anonymous').slice(0, 64),
    ip: String((entry && entry.ip) || '').slice(0, 64),
    action: String((entry && entry.action) || '').slice(0, 64),
    detail: entry && entry.detail ? String(entry.detail).slice(0, 500) : '',
    result: (entry && entry.result) || 'ok',
  };

  ring.push(rec);
  if (ring.length > RING_SIZE) ring.shift();

  writeQueue = writeQueue.then(async () => {
    try {
      ensureDir();
      try {
        const st = await fsp.stat(LOG_PATH);
        if (st.size > MAX_BYTES) {
          await fsp.rename(LOG_PATH, LOG_PATH + '.1').catch(() => {});
        }
      } catch {  }
      await fsp.appendFile(LOG_PATH, JSON.stringify(rec) + '\n', 'utf8');
    } catch (e) {
      dropped++;
      if (dropped <= 3) console.error('[audit] 写入失败:', e.message);
    }
  });

  return rec;
}

async function readFromFile() {
  try {
    const raw = await fsp.readFile(LOG_PATH, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch {  }
    }
    return out;
  } catch {
    return [];
  }
}

async function query({ limit = 100, offset = 0, user, action, result } = {}) {
  const need = Math.max(1, Math.min(1000, parseInt(limit, 10) || 100));
  const skip = Math.max(0, parseInt(offset, 10) || 0);

  let list = ring;
  if (skip + need > ring.length) list = await readFromFile();

  let out = list.slice().reverse();
  if (user) out = out.filter(r => r.user === user);
  if (action) out = out.filter(r => r.action === action);
  if (result) out = out.filter(r => r.result === result);

  return {
    total: out.length,
    items: out.slice(skip, skip + need),
    memoryCount: ring.length,
    dropped,
  };
}

function actions() {
  const set = new Set();
  for (const r of ring) set.add(r.action);
  return Array.from(set).sort();
}

async function init() {
  const all = await readFromFile();
  ring = all.slice(-RING_SIZE);
  if (all.length) {
    console.log(`[audit] 载入 ${ring.length}/${all.length} 条操作日志`);
  }
}

module.exports = { record, query, actions, init, clientIp, LOG_PATH };
