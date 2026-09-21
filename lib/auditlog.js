'use strict';
/**
 * 管理员操作日志（仅管理员可查）。
 *
 * 存储选型：JSONL 追加写（DATA_DIR/audit.log），每行一条 JSON。
 * 相比 JSON 数组的好处：
 *   - 追加是 O(1)，不必每次重写整个文件（jsonstore 那种原子写对高频日志开销太大）
 *   - 单行损坏只丢一条，不会像 JSON 数组那样整个文件解析失败
 *   - 读取时倒序取尾部即可，日志再大也不拖慢查询
 *
 * 两道内存/磁盘保护：
 *   - 内存环形缓冲只保留最近 N 条，避免长期运行内存无上限增长
 *   - 单文件超过阈值就轮转（保留一代 .1），不会把 NAS 磁盘写满
 *
 * 关键约束：**record() 永不抛异常、永不阻塞业务请求** ——
 * 审计失败绝不能影响用户正在做的事。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'audit.log');
const MAX_BYTES = 5 * 1024 * 1024;   // 单文件 5MB 触发轮转
const RING_SIZE = 500;               // 内存中保留的最近条数

let ring = [];                       // 最近日志（内存），启动时从文件尾部载入
let writeQueue = Promise.resolve();  // 串行化写入，避免并发 append 交错
let dropped = 0;                     // 写失败计数（供诊断，不抛给调用方）

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 忽略 */ }
}

/** 取客户端 IP：优先反代头，其次 socket 地址 */
function clientIp(req) {
  if (!req) return '';
  const xff = (req.headers && req.headers['x-forwarded-for']) || '';
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || '';
}

/**
 * 记一条日志。同步返回记录对象，落盘在后台串行进行。
 * @param {{user?:string, ip?:string, action:string, detail?:string, result?:string}} entry
 */
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

  // 后台串行落盘：不 await，不影响请求
  writeQueue = writeQueue.then(async () => {
    try {
      ensureDir();
      // 轮转（只保留一代）
      try {
        const st = await fsp.stat(LOG_PATH);
        if (st.size > MAX_BYTES) {
          await fsp.rename(LOG_PATH, LOG_PATH + '.1').catch(() => {});
        }
      } catch { /* 文件还不存在 */ }
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
      try { out.push(JSON.parse(s)); } catch { /* 跳过损坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 查询日志，返回**最新在前**。
 * 内存环形够用就直接用（常见情形，零 IO）；不够再回读文件。
 */
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

/** 供管理页做筛选项 */
function actions() {
  const set = new Set();
  for (const r of ring) set.add(r.action);
  return Array.from(set).sort();
}

/** 启动时载入尾部，让首次查询就能命中内存 */
async function init() {
  const all = await readFromFile();
  ring = all.slice(-RING_SIZE);
  if (all.length) {
    console.log(`[audit] 载入 ${ring.length}/${all.length} 条操作日志`);
  }
}

module.exports = { record, query, actions, init, clientIp, LOG_PATH };
