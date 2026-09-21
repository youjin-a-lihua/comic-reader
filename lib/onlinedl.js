'use strict';
/**
 * 在线阅读源 → 本地库 的下载/入库任务管理器。
 *
 * 用途：在线阅读（逐张走 /api/online/img 代理）慢且依赖源站可用性；
 * 本模块把在线章节的图片拉全、转 JPEG、合成 PDF，落盘到本地漫画库，
 * 之后即可走本地 PDF 通道快速阅读。
 *
 * 设计要点：
 *   - 异步任务 + 进度轮询（单章节可能上百页，同步请求必然超时）
 *   - 串行拉图（避免被源站限流/封禁），单图超时保护
 *   - 先写 .part 再 rename（原子落盘，中断不会留下半截 PDF）
 *   - 同名文件覆盖同章节的历史版本，避免重复下载堆积
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { getOnlineImage } = require('./online-image');
const { buildPdfFromJpegs } = require('./imgpdf');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// 下载历史（持久化，重启不丢）：只存摘要，不存任务运行时状态
const HISTORY_FILE = path.join(DATA_DIR, 'downloads.json');
const historyStore = getStore(HISTORY_FILE, []);
const HISTORY_MAX = 200;   // 只保留最近 N 条，避免文件无限增长

const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;      // 完成/失败的任务保留 1 小时供前端查询
const MAX_RUNNING = 2;                   // 同时运行的下载任务上限
const JPEG_QUALITY = 88;
const MAX_PAGES_PER_EP = 800;            // 单章节页数上限（防御异常源）
const PER_IMAGE_TIMEOUT_MS = 30000;
const JPEG_CONCURRENCY = 3;              // sharp 转码并发（CPU 密集，NAS 上不宜过高）

let running = 0;

// ── 工具 ────────────────────────────────────────────

function safeFileName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 120) || 'untitled';
}

function withTimeout(promise, ms, msg) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function gcJobs() {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    if ((j.status === 'done' || j.status === 'error') && now - j.updatedAt > JOB_TTL_MS) {
      JOBS.delete(id);
    }
  }
}

// 有界并发 map（保序返回）
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 单章节：拉图 → 合成 PDF ──────────────────────────

async function buildEpisodePdf(job, source, ep) {
  const ch = await source.chapter(ep.id);
  const urls = (ch && ch.images) || [];
  if (!urls.length) throw new Error(`章节「${ep.title}」没有图片`);
  if (urls.length > MAX_PAGES_PER_EP) {
    throw new Error(`章节页数异常（${urls.length} > ${MAX_PAGES_PER_EP}）`);
  }

  job.pageTotal = urls.length;
  job.pageDone = 0;
  job.epTitle = ep.title;

  // 逐张拉取（串行，尊重源站），失败重试 2 次
  const rawBuffers = [];
  for (let i = 0; i < urls.length; i++) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await withTimeout(
          getOnlineImage(urls[i]), PER_IMAGE_TIMEOUT_MS,
          `第 ${i + 1} 页拉取超时`
        );
        if (r && r.error) throw new Error(r.error);
        if (!r || !r.buffer) throw new Error('空响应');
        rawBuffers.push(r.buffer);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
      }
    }
    if (lastErr) throw new Error(`第 ${i + 1}/${urls.length} 页失败：${lastErr.message}`);
    job.pageDone = i + 1;
    job.message = `下载中 ${i + 1}/${urls.length}`;
  }

  // 转 JPEG（DCTDecode 直嵌 PDF，先压 alpha 保证 RGB 三通道）
  job.message = '转码中…';
  let done = 0;
  const jpegs = await mapLimit(rawBuffers, JPEG_CONCURRENCY, async (buf) => {
    const out = await sharp(buf)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });
    done++;
    job.message = `转码中 ${done}/${rawBuffers.length}`;
    return {
      data: out.data,
      width: out.info.width,
      height: out.info.height,
      channels: out.info.channels,
    };
  });

  job.message = '生成 PDF…';
  const pdf = buildPdfFromJpegs(jpegs);
  return { pdf, pageCount: jpegs.length };
}

// ── 落盘（原子写）────────────────────────────────────

async function writeComic(job, targetDir, baseName, pdf, meta) {
  await fsp.mkdir(targetDir, { recursive: true });
  const pdfPath = path.join(targetDir, baseName + '.pdf');
  const metaPath = path.join(targetDir, baseName + '.meta.json');

  const tmpPdf = pdfPath + '.part';
  await fsp.writeFile(tmpPdf, pdf);
  await fsp.rename(tmpPdf, pdfPath);

  try {
    const tmpMeta = metaPath + '.part';
    await fsp.writeFile(tmpMeta, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tmpMeta, metaPath);
  } catch (e) {
    // meta 写失败不影响漫画可用（scanner 会退回文件名作标题）
    console.error('[onlinedl] 写 meta 失败：', e.message);
  }

  return pdfPath;
}

// ── 下载历史（持久化，重启不丢）─────────────────────

/** 记一条下载历史（jsonstore 原子写 + 写合并，调用方无需 await） */
function pushHistory(rec) {
  try {
    historyStore.update(list => {
      const arr = Array.isArray(list) ? list : [];
      arr.unshift(rec);
      return arr.slice(0, HISTORY_MAX);
    });
  } catch (e) {
    console.error('[onlinedl] 写历史失败:', e.message);
  }
}

/** 查询下载历史，最新在前 */
function listHistory({ limit = 50, offset = 0 } = {}) {
  const all = historyStore.read();
  const arr = Array.isArray(all) ? all : [];
  const n = Math.max(1, Math.min(HISTORY_MAX, parseInt(limit, 10) || 50));
  const s = Math.max(0, parseInt(offset, 10) || 0);
  return { total: arr.length, items: arr.slice(s, s + n) };
}

// ── 任务主体 ────────────────────────────────────────

async function runJob(job, opts) {
  const {
    source, episodes, albumTitle, sourceKey, sourceId,
    authors = [], tags = [], targetDir,
  } = opts;

  const now = () => new Date().toISOString();

  try {
    job.status = 'running';
    job.updatedAt = Date.now();

    let index = 0;
    for (const ep of episodes) {
      job.epIndex = index + 1;
      job.epCount = episodes.length;

      const { pdf, pageCount } = await buildEpisodePdf(job, source, ep);

      // 文件名：<相册标题>_<章节标题>_<epId>.pdf（单章节时省略重复的章节名）
      const nameParts = [albumTitle];
      if (episodes.length > 1 && ep.title) nameParts.push(ep.title);
      nameParts.push(String(ep.id));
      const baseName = safeFileName(nameParts.filter(Boolean).join('_'));

      const iso = now();
      const meta = {
        title: ep.title && episodes.length > 1 ? `${albumTitle} ${ep.title}` : (albumTitle || baseName),
        fullTitle: albumTitle || baseName,
        source: sourceKey || '',
        sourceId: String(sourceId || ep.id || ''),
        authors,
        artists: [],
        tags,
        genres: [],
        series: albumTitle || '',
        status: 'unknown',
        language: '',
        isTranslated: false,
        chapterCount: episodes.length,
        pageCount,
        publishedAt: '',
        createdAt: iso,
        updatedAt: iso,
      };

      job.message = '写入库…';
      const saved = await writeComic(job, targetDir, baseName, pdf, meta);
      job.files.push(path.basename(saved));

      index++;
      job.pageDone = job.pageTotal;
      job.overall = Math.round((index / episodes.length) * 100);
      job.updatedAt = Date.now();
    }

    job.status = 'done';
    job.overall = 100;
    job.message = `已入库 ${job.files.length} 个文件`;
    job.updatedAt = Date.now();
    pushHistory({
      id: job.id, title: job.title, status: 'done',
      epCount: job.epCount, files: job.files.slice(),
      user: opts.user || '', ip: opts.ip || '',
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    job.status = 'error';
    job.error = (err && err.message) || String(err);
    job.message = '下载失败：' + job.error;
    job.updatedAt = Date.now();
    console.error('[onlinedl]', job.id, job.error);
    pushHistory({
      id: job.id, title: job.title, status: 'error', error: job.error,
      epCount: job.epCount, files: job.files.slice(),
      user: opts.user || '', ip: opts.ip || '',
      finishedAt: new Date().toISOString(),
    });
  } finally {
    running = Math.max(0, running - 1);
  }
}

// ── 对外接口 ────────────────────────────────────────

/**
 * 创建下载任务（立即返回 job，后台执行）
 * @param {object} opts
 * @param {object} opts.source      在线源实现（lib/sources/*.js）
 * @param {Array}  opts.episodes    [{ id, title }]
 * @param {string} opts.albumTitle  相册标题（用于命名与 meta）
 * @param {string} opts.sourceKey   源 key（jm…）
 * @param {string} opts.sourceId    相册 id（可选）
 * @param {string} opts.targetDir   目标库目录
 */
function startDownload(opts) {
  gcJobs();
  if (running >= MAX_RUNNING) {
    return { error: `当前已有 ${running} 个下载任务在进行，请稍后再试` };
  }
  if (!opts || !opts.source || !Array.isArray(opts.episodes) || !opts.episodes.length) {
    return { error: '参数不完整：缺少 source / episodes' };
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'pending',
    title: opts.albumTitle || '',
    epIndex: 0,
    epCount: opts.episodes.length,
    epTitle: '',
    pageTotal: 0,
    pageDone: 0,
    overall: 0,
    files: [],
    error: '',
    message: '排队中…',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  JOBS.set(job.id, job);
  running++;
  // 异步执行，不阻塞 HTTP 响应
  setImmediate(() => runJob(job, opts));
  return { job };
}

function getJob(id) {
  return JOBS.get(id) || null;
}

/** 供前端展示的瘦身版状态 */
function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    epIndex: job.epIndex,
    epCount: job.epCount,
    epTitle: job.epTitle,
    pageTotal: job.pageTotal,
    pageDone: job.pageDone,
    overall: job.overall,
    files: job.files,
    message: job.message,
    error: job.error,
  };
}

module.exports = { startDownload, getJob, publicJob, listHistory };
