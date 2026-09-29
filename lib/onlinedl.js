'use strict';
// Downloads online chapters into the local library as PDFs, as background jobs.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const { getOnlineImage } = require('./online-image');
const { buildPdfFromJpegs } = require('./imgpdf');
const { getStore } = require('./jsonstore');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'downloads.json');
const historyStore = getStore(HISTORY_FILE, []);
const HISTORY_MAX = 200;

const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_RUNNING = 2;
const JPEG_QUALITY = 88;
const MAX_PAGES_PER_EP = 800;
const PER_IMAGE_TIMEOUT_MS = 30000;
const JPEG_CONCURRENCY = 3; // sharp concurrency stays low because this runs on a NAS.

let running = 0;

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

  // Fetch pages one at a time to stay under the origin's rate limits.
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
    console.error('[onlinedl] 写 meta 失败：', e.message);
  }

  return pdfPath;
}

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

function listHistory({ limit = 50, offset = 0 } = {}) {
  const all = historyStore.read();
  const arr = Array.isArray(all) ? all : [];
  const n = Math.max(1, Math.min(HISTORY_MAX, parseInt(limit, 10) || 50));
  const s = Math.max(0, parseInt(offset, 10) || 0);
  return { total: arr.length, items: arr.slice(s, s + n) };
}

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
  setImmediate(() => runJob(job, opts));
  return { job };
}

function getJob(id) {
  return JOBS.get(id) || null;
}

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
