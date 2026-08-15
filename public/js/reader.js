/**
 * 漫画阅读器
 * 支持 PDF（pdf.js）、CBZ/CBR（逐页图片）
 * 双页模式、RTL（漫画方向）、缩放、键盘快捷键
 */

let readerState = null;

// pdf.js 全局引用
let pdfjsLib = null;
let pdfDoc = null;
let pdfState = null;  // PDF 章节目录状态（仿 epubState）

// ── 打开阅读器 ──

async function openReader(comic, startPage) {
  // EPUB 用专用阅读器
  if (comic.ext === 'epub') {
    return openEpubReader(comic);
  }
  // 获取信息
  let info = comic;
  if (!info.pageCount && info.ext === 'pdf') {
    try {
      const res = await ComicAPI.getComicInfo(comic.id);
      info = res;
    } catch {}
  }

  // PDF 章节目录状态（详情页点击某章进入时，起始页优先于阅读进度）
  pdfState = comic.ext === 'pdf'
    ? { toc: [], hasToc: false, sidebarOpen: false, tocLoaded: false }
    : null;

  readerState = {
    comic: info,
    currentPage: startPage || info.progress?.page || 1,
    totalPages: info.pageCount || 0,
    zoom: 'fit-width',
    mode: info.ext === 'pdf' ? 'scroll' : 'single',  // PDF 默认滚动，CBZ 默认单页
    direction: 'ltr',
    bookmarked: info.progress?.bookmarked || false,
    controlsVisible: true,
    renderedPages: new Set(),  // 已渲染的页码
    scrollObserver: null,
  };

  // 构建阅读器 UI
  buildReaderUI();

  // 加载内容
  await loadPage();
}

// ── 构建阅读器 DOM ──

function buildReaderUI() {
  const container = document.getElementById('reader');
  const isScroll = readerState.mode === 'scroll';

  container.innerHTML = `
    <div class="reader-topbar" id="readerTopbar">
      <button class="back-btn" onclick="closeReader()" title="返回">←</button>
      <span class="comic-title">${escHtml(readerState.comic.name)}</span>
      <span class="page-info" id="pageInfo">- / -</span>
      ${readerState.comic.online ? '' : `
      <button class="tool-btn" id="btnBookmark" onclick="toggleBookmark()" title="收藏">
        ${readerState.bookmarked ? '★' : '☆'}
      </button>
      <button class="tool-btn" id="btnLike" onclick="toggleLikeComic()" title="点赞">🤍</button>`}
      <button class="tool-btn" id="btnMode" onclick="toggleMode()" title="${isScroll ? '切换翻页' : '切换滚动'}">${isScroll ? '📜' : '📄'}</button>
      <button class="tool-btn" id="btnDirection" onclick="toggleDirection()" title="阅读方向">⇄</button>
      ${readerState.comic.ext === 'pdf' ? `<button class="tool-btn" id="pdfBtnToc" onclick="pdfToggleSidebar()" title="目录" style="display:none">☰</button>` : ''}
    </div>

    ${readerState.comic.ext === 'pdf' ? `
    <div class="pdf-sidebar" id="pdfSidebar">
      <div class="pdf-sidebar-header"><span>目录</span><button class="tool-btn" onclick="pdfToggleSidebar()">✕</button></div>
      <div class="pdf-toc" id="pdfToc"></div>
    </div>` : ''}

    <div class="reader-viewport ${isScroll ? 'scroll-mode' : ''}" id="readerViewport">
      ${!isScroll ? `
        <div class="tap-zone prev" onclick="prevPage()"></div>
        <div class="tap-zone next" onclick="nextPage()"></div>
      ` : ''}
      <div class="zoom-indicator" id="zoomIndicator"></div>
      <div class="reader-loading" id="readerLoading">
        <div class="spinner"></div>
      </div>
    </div>

    <div class="reader-bottombar" id="readerBottombar">
      <div class="bottombar-actions">
        <button class="bottombar-btn" onclick="changeZoom('fit-width')" title="适应宽度">↔</button>
        <button class="bottombar-btn" onclick="changeZoom('fit-height')" title="适应高度">↕</button>
        <button class="bottombar-btn" onclick="changeZoom('100')" title="100%">1:1</button>
      </div>
      <input type="range" class="page-slider" id="pageSlider" min="1" max="${readerState.totalPages || 100}" value="${readerState.currentPage}" oninput="jumpToPage(this.value)">
      <span class="page-info" id="pageInfoBottom" style="font-size:12px;color:rgba(255,255,255,0.7);min-width:60px;text-align:right;">
        ${readerState.currentPage} / ${readerState.totalPages || '?'}
      </span>
    </div>
  `;

  container.style.display = 'flex';
  document.body.classList.add('reader-mode');

  updateBookmarkBtn();
  updateModeBtn();
  updateDirectionBtn();

  // PDF 目录：DOM 重建后恢复「☰」按钮与列表（切换模式会重走这里）
  if (pdfState && pdfState.hasToc) {
    const btn = document.getElementById('pdfBtnToc');
    if (btn) btn.style.display = '';
    renderPdfToc();
  }
}

// ── 加载页面 ──

async function loadPage() {
  if (readerState.mode === 'scroll') {
    return loadScrollMode();
  }

  const loading = document.getElementById('readerLoading');
  if (loading) loading.style.display = 'flex';

  const viewport = document.getElementById('readerViewport');
  viewport.querySelectorAll('canvas, img.page-image').forEach(el => el.remove());

  const { comic, currentPage, mode } = readerState;

  try {
    if (comic.ext === 'pdf') {
      await loadPdfPage(currentPage, mode);
    } else {
      await loadCbzPage(currentPage);
    }
  } catch (err) {
    console.error('加载页面失败:', err);
    viewport.innerHTML += '<div style="color:#fff;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">加载失败</div>';
  }

  if (loading) loading.style.display = 'none';
  updateUI();
  saveProgress();
}

async function loadPdfPage(pageNum, mode) {
  // Wait for pdfjs to be ready
  if (!pdfjsLib) {
    for (var i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (pdfjsLib) break;
    }
    if (!pdfjsLib) { console.error('pdfjs not loaded'); return; }
  }

  if (!pdfDoc) {
    const url = ComicAPI.getFileUrl(readerState.comic.id);
    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: true,
      httpHeaders: { 'Authorization': `Bearer ${getToken()}` }
    });
    pdfDoc = await loadingTask.promise;
    readerState.totalPages = pdfDoc.numPages;
    loadPdfOutline();
  }

  const viewportEl = document.getElementById('readerViewport');

  if (mode === 'double' && pageNum < readerState.totalPages) {
    // 双页：当前页 + 下一页
    const [page1, page2] = await Promise.all([
      pdfDoc.getPage(pageNum),
      pdfDoc.getPage(pageNum + 1)
    ]);

    const canvas1 = await renderPdfPageToCanvas(page1, 'double');
    const canvas2 = await renderPdfPageToCanvas(page2, 'double');

    // 清除旧 canvas
    viewportEl.querySelectorAll('canvas').forEach(c => c.remove());

    if (readerState.direction === 'rtl') {
      viewportEl.appendChild(canvas2);
      viewportEl.appendChild(canvas1);
    } else {
      viewportEl.appendChild(canvas1);
      viewportEl.appendChild(canvas2);
    }
  } else {
    // 单页
    const page = await pdfDoc.getPage(pageNum);
    const canvas = await renderPdfPageToCanvas(page, 'single');
    viewportEl.querySelectorAll('canvas').forEach(c => c.remove());
    viewportEl.appendChild(canvas);
  }
}

async function renderPdfPageToCanvas(page, displayMode) {
  const viewportEl = document.getElementById('readerViewport');
  const rect = viewportEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const maxW = displayMode === 'double' ? rect.width * 0.48 : rect.width;
  const maxH = rect.height;

  let scale;
  const origViewport = page.getViewport({ scale: 1 });

  switch (readerState.zoom) {
    case 'fit-width':
      scale = (maxW * dpr) / origViewport.width;
      break;
    case 'fit-height':
      scale = (maxH * dpr) / origViewport.height;
      break;
    default:
      scale = (parseInt(readerState.zoom) / 100) * dpr;
  }

  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = (viewport.width / dpr) + 'px';
  canvas.style.height = (viewport.height / dpr) + 'px';

  await page.render({ canvasContext: ctx, viewport }).promise;

  return canvas;
}

async function loadCbzPage(pageNum) {
  const viewportEl = document.getElementById('readerViewport');
  const img = document.createElement('img');
  img.className = 'page-image';
  const comic = readerState.comic;
  // 在线漫画：图片走 /api/online/img 代理（后端拉取 + 反乱序）
  if (comic.online && Array.isArray(comic.images)) {
    const rawUrl = comic.images[pageNum - 1];
    img.src = `/api/online/img?url=${encodeURIComponent(rawUrl)}&token=${encodeURIComponent(getToken())}`;
  } else {
    img.src = ComicAPI.getPageUrl(comic.id, pageNum);
  }

  img.onerror = () => {
    img.style.display = 'none';
    viewportEl.innerHTML += '<div style="color:#fff;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">页面加载失败</div>';
  };

  viewportEl.querySelectorAll('img.page-image').forEach(el => el.remove());
  viewportEl.appendChild(img);

  // 更新总页数（首次加载时获取）；在线漫画已在 openReader 前设置好
  if (!readerState.totalPages) {
    if (comic.online && Array.isArray(comic.images)) {
      readerState.totalPages = comic.images.length;
    } else {
      try {
        const info = await ComicAPI.getComicInfo(comic.id);
        readerState.totalPages = info.pageCount || 0;
      } catch {}
    }
  }
}

// ── 滚动阅读模式 ────────────────────────────────────

async function loadScrollMode() {
  const viewport = document.getElementById('readerViewport');
  const loading = document.getElementById('readerLoading');
  if (loading) loading.style.display = 'flex';

  if (!pdfjsLib) {
    for (var i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (pdfjsLib) break;
    }
    if (!pdfjsLib) return;
  }

  if (!pdfDoc) {
    const url = ComicAPI.getFileUrl(readerState.comic.id);
    const loadingTask = pdfjsLib.getDocument({
      url, withCredentials: true,
      httpHeaders: { 'Authorization': `Bearer ${getToken()}` }
    });
    pdfDoc = await loadingTask.promise;
    readerState.totalPages = pdfDoc.numPages;
    loadPdfOutline();
  }

  viewport.innerHTML = '<div class="scroll-pages" id="scrollPages"></div>';
  const scrollPages = document.getElementById('scrollPages');

  for (let p = 1; p <= readerState.totalPages; p++) {
    const div = document.createElement('div');
    div.className = 'scroll-page';
    div.id = 'scroll-page-' + p;
    div.dataset.page = p;
    div.innerHTML = '<div class="scroll-page-placeholder" style="aspect-ratio:3/4;background:rgba(255,255,255,0.02)"></div>';
    scrollPages.appendChild(div);
  }

  if (loading) loading.style.display = 'none';

  // 懒加载 + 卸载（防 200 页 Canvas 堆积导致移动端 OOM）
  if (readerState.scrollObserver) readerState.scrollObserver.disconnect();
  readerState.scrollObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pn = parseInt(entry.target.dataset.page);
      if (entry.isIntersecting) {
        // 进入可视区 + 缓冲区：若未渲染则绘制 Canvas
        if (!readerState.renderedPages.has(pn)) {
          readerState.renderedPages.add(pn);
          renderScrollPage(pn);
        }
      } else {
        // 离开可视区 + 缓冲区（2 屏外）：卸载 Canvas 释放显存
        if (readerState.renderedPages.has(pn)) {
          const el = document.getElementById('scroll-page-' + pn);
          if (el) {
            const c = el.querySelector('canvas');
            if (c) {
              // 强迫 WebKit (iOS Safari) 立即释放 GPU 显存区块
              const ctx = c.getContext('2d');
              ctx && ctx.clearRect && ctx.clearRect(0, 0, 1, 1);
              c.width = 0;
              c.height = 0;
              c.remove();
            }
            readerState.renderedPages.delete(pn);
          }
        }
      }
    }
  }, { rootMargin: '800px 0px' });

  // 前 2 页立即渲染
  document.querySelectorAll('.scroll-page').forEach(el => {
    readerState.scrollObserver.observe(el);
    const pn = parseInt(el.dataset.page);
    if (pn <= 2 && !readerState.renderedPages.has(pn)) {
      readerState.renderedPages.add(pn);
      renderScrollPage(pn);
    }
  });

  if (readerState.currentPage > 1) {
    setTimeout(() => {
      const t = document.getElementById('scroll-page-' + readerState.currentPage);
      if (t) t.scrollIntoView({ behavior: 'instant' });
    }, 600);
  }

  viewport.addEventListener('scroll', debounce(updateScrollProgress, 300));
  attachScrollSnapFallback();
  updateUI();
}

async function renderScrollPage(pageNum) {
  if (!pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(pageNum);
    const vp = document.getElementById('readerViewport');
    const rect = vp.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const maxW = rect.width;

    const orig = page.getViewport({ scale: 1 });
    let scale;
    switch (readerState.zoom) {
      case 'fit-width': scale = (maxW * dpr) / orig.width; break;
      case 'fit-height': scale = (rect.height * dpr) / orig.height; break;
      default: scale = (parseInt(readerState.zoom) / 100) * dpr;
    }

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // 每页占满一屏：canvas 自适应 .scroll-page 容器（max 100% + contain 保持比例）
    canvas.style.maxWidth = '100%';
    canvas.style.maxHeight = '100%';
    canvas.style.width = 'auto';
    canvas.style.height = 'auto';
    canvas.style.objectFit = 'contain';
    canvas.style.display = 'block';
    canvas.style.margin = '0';

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const div = document.getElementById('scroll-page-' + pageNum);
    if (div) { div.innerHTML = ''; div.appendChild(canvas); }
  } catch (e) { console.error('scroll render err', pageNum, e); }
}

function updateScrollProgress() {
  if (!readerState || readerState.mode !== 'scroll') return;
  const vp = document.getElementById('readerViewport');
  const pages = vp.querySelectorAll('.scroll-page');
  let best = 1, bestRatio = 0;
  const vpRect = vp.getBoundingClientRect();
  for (const page of pages) {
    const r = page.getBoundingClientRect();
    const top = Math.max(r.top, vpRect.top);
    const bot = Math.min(r.bottom, vpRect.bottom);
    const ratio = Math.max(0, bot - top) / r.height;
    if (ratio > bestRatio) { bestRatio = ratio; best = parseInt(page.dataset.page); }
  }
  if (best !== readerState.currentPage) {
    readerState.currentPage = best;
    updateUI();
    saveProgress();
  }
}

function debounce(fn, ms) {
  let t;
  return function() { clearTimeout(t); t = setTimeout(fn, ms); };
}

// iOS 26 对 scroll-snap-stop:always 兼容不稳定，惯性滑动仍可能飞过多页。
// 兜底：滚动停止后，把容器吸附到离视口顶最近的 .scroll-page，确保一次只停在一页。
function attachScrollSnapFallback() {
  const vp = document.getElementById('readerViewport');
  if (!vp) return;
  if (readerState._snapHandler) {
    vp.removeEventListener('scroll', readerState._snapHandler);
    readerState._snapHandler = null;
  }
  let timer = null;
  const handler = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const pages = vp.querySelectorAll('.scroll-page');
      if (!pages.length) return;
      const vpTop = vp.getBoundingClientRect().top;
      let nearest = null, nearestDist = Infinity;
      pages.forEach(p => {
        const top = p.getBoundingClientRect().top - vpTop;
        const dist = Math.abs(top);
        if (dist < nearestDist) { nearestDist = dist; nearest = p; }
      });
      // 仅在未对齐（>2px）时强制吸附，避免无谓抖动
      if (nearest && nearestDist > 2) {
        nearest.scrollIntoView({ behavior: 'auto' });
      }
    }, 80);
  };
  vp.addEventListener('scroll', handler, { passive: true });
  readerState._snapHandler = handler;
}

// ── 翻页 ──

function nextPage() {
  const maxPage = readerState.totalPages || 99999;
  const step = readerState.mode === 'double' ? 2 : 1;
  if (readerState.currentPage + step <= maxPage) {
    readerState.currentPage += step;
    loadPage();
  }
}

function prevPage() {
  const step = readerState.mode === 'double' ? 2 : 1;
  if (readerState.currentPage - step >= 1) {
    readerState.currentPage -= step;
    loadPage();
  } else if (readerState.currentPage > 1) {
    readerState.currentPage = 1;
    loadPage();
  }
}

function jumpToPage(val) {
  const page = parseInt(val, 10);
  if (page >= 1 && page <= (readerState.totalPages || 99999)) {
    // 双页模式下确保从奇数页开始
    if (readerState.mode === 'double' && page % 2 === 0) {
      readerState.currentPage = page - 1;
    } else {
      readerState.currentPage = page;
    }
    loadPage();
  }
}

// ── UI 更新 ──

function updateUI() {
  const slider = document.getElementById('pageSlider');
  if (slider) {
    slider.max = readerState.totalPages || 100;
    slider.value = readerState.currentPage;
  }
  const info = document.getElementById('pageInfo');
  if (info) info.textContent = `${readerState.currentPage} / ${readerState.totalPages || '?'}`;
  const infoB = document.getElementById('pageInfoBottom');
  if (infoB) infoB.textContent = `${readerState.currentPage} / ${readerState.totalPages || '?'}`;
}

function updateBookmarkBtn() {
  const btn = document.getElementById('btnBookmark');
  if (btn) btn.textContent = readerState.bookmarked ? '★' : '☆';
}

function updateModeBtn() {
  const btn = document.getElementById('btnMode');
  if (!btn) return;
  if (readerState.mode === 'scroll') btn.textContent = '📜';
  else if (readerState.mode === 'double') btn.textContent = '⊟';
  else btn.textContent = '📄';
}

function updateDirectionBtn() {
  const btn = document.getElementById('btnDirection');
  if (btn) btn.textContent = readerState.direction === 'rtl' ? '⇦' : '⇄';
}

// ── 保存进度 ──

function saveProgress() {
  if (!readerState) return;
  ComicAPI.saveProgress(
    readerState.comic.id,
    readerState.currentPage,
    readerState.totalPages
  ).catch(() => {});
}

// ── 切换功能 ──

function toggleBookmark() {
  readerState.bookmarked = !readerState.bookmarked;
  updateBookmarkBtn();
  ComicAPI.toggleBookmark(readerState.comic.id).catch(() => {});
}

function toggleMode() {
  // 滚动 ↔ 翻页
  if (readerState.mode === 'scroll') {
    readerState.mode = 'single';
  } else if (readerState.mode === 'single') {
    readerState.mode = 'double';
  } else {
    readerState.mode = 'scroll';
  }

  if (readerState.scrollObserver) readerState.scrollObserver.disconnect();
  readerState.renderedPages.clear();

  if (readerState.comic.ext === 'pdf') pdfDoc = null;

  updateModeBtn();
  buildReaderUI();
  loadPage();
}

function toggleDirection() {
  readerState.direction = readerState.direction === 'ltr' ? 'rtl' : 'ltr';
  updateDirectionBtn();

  const viewport = document.getElementById('readerViewport');
  if (readerState.direction === 'rtl') {
    viewport.classList.add('rtl');
  } else {
    viewport.classList.remove('rtl');
  }

  if (readerState.comic.ext === 'pdf' && readerState.mode === 'double') {
    pdfDoc = null;
    loadPage();
  }
}

function changeZoom(zoom) {
  readerState.zoom = zoom;
  showZoomIndicator(zoom);

  if (readerState.comic.ext === 'pdf') {
    pdfDoc = null;
  }
  loadPage();
}

function showZoomIndicator(zoom) {
  const el = document.getElementById('zoomIndicator');
  const labels = {
    'fit-width': '适应宽度',
    'fit-height': '适应高度',
    '100': '100%',
    '150': '150%',
    '200': '200%'
  };
  el.textContent = labels[zoom] || zoom;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 1200);
}

// ── 关闭阅读器 ──

function closeReader() {
  const closingId = readerState ? readerState.comic.id : null;
  const wasOnline = !!(readerState && readerState.comic.online);
  if (!wasOnline) saveProgress(); // 在线漫画不保存本地进度
  if (readerState && readerState.scrollObserver) readerState.scrollObserver.disconnect();
  pdfDoc = null;
  pdfState = null;
  readerState = null;

  const container = document.getElementById('reader');
  container.style.display = 'none';
  container.innerHTML = '';
  document.body.classList.remove('reader-mode');

  if (wasOnline) {
    // 在线阅读退出 → 直接回到在线详情页（章节列表），不碰书架
    window._libraryNeedsRefresh = false;
    switchPage('detail');
    return;
  }

  // 标记需要刷新书架数据（进度已变，"继续阅读"需重排）
  window._libraryNeedsRefresh = true;

  // 退出阅读器 → 回到同系列详情页（而非书架顶部），符合正常返回逻辑
  if (closingId && typeof showDetailForComic === 'function') showDetailForComic(closingId);
  else loadLibraryData();
}

// ── 触屏手势：双指缩放 + 双击放大 ──────────────

let touchState = {
  active: false, startDist: 0, startZoom: '',
  tapX: 0, tapY: 0, lastTapTime: 0
};

document.addEventListener('touchstart', (e) => {
  if (!readerState) return;

  // 记录单指位置（双击判断用）
  if (e.touches.length === 1) {
    touchState.tapX = e.touches[0].clientX;
    touchState.tapY = e.touches[0].clientY;
  }

  // 双指缩放开始（touch-action: pan-y 已禁用原生缩放，无需 preventDefault，
  // 否则非 passive 监听会拖垮 iOS 的滚动平滑度）
  if (e.touches.length === 2) {
    touchState.active = true;
    touchState.startDist = getTouchDist(e.touches);
    touchState.startZoom = readerState.zoom;
  }
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!readerState || !touchState.active || e.touches.length !== 2) return;

  const newDist = getTouchDist(e.touches);
  const ratio = newDist / touchState.startDist;
  const currentScale = zoomToScale(readerState.zoom);
  const newScale = Math.max(0.3, Math.min(5, currentScale * ratio));
  showZoomIndicator(Math.round(newScale * 100) + '%');
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (!readerState) return;

  // ── 双击检测（touchend 阶段，手指离开后判断） ──
  if (!touchState.active && e.changedTouches.length === 1) {
    const t = e.changedTouches[0];
    const dx = Math.abs(t.clientX - touchState.tapX);
    const dy = Math.abs(t.clientY - touchState.tapY);
    const moved = dx > 20 || dy > 20; // 滑动超过 20px 不算点击

    if (!moved) {
      const now = Date.now();
      if (now - touchState.lastTapTime < 350 && touchState.lastTapTime > 0) {
        e.preventDefault();
        handleDoubleTap(t);
        touchState.lastTapTime = 0;
        return;
      }
      touchState.lastTapTime = now;
    }
  }

  // ── 双指缩放结束 ──
  if (!touchState.active) return;
  touchState.active = false;

  if (e.touches.length < 2) {
    const currentScale = zoomToScale(readerState.zoom);
    const ratio = touchState.startDist > 0
      ? getLastTouchDist() / touchState.startDist
      : 1;
    const newScale = Math.max(0.3, Math.min(5, currentScale * ratio));

    const levels = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    let closest = levels[0];
    let minDiff = Math.abs(newScale - levels[0]);
    for (const l of levels) {
      const d = Math.abs(newScale - l);
      if (d < minDiff) { minDiff = d; closest = l; }
    }

    readerState.zoom = Math.round(closest * 100).toString();
    showZoomIndicator(zoomLabel(readerState.zoom));
    reloadContent();
  }
});

let lastTouchDist = 0;
function getLastTouchDist() { return lastTouchDist; }

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  lastTouchDist = dist;
  return dist;
}

function handleDoubleTap(touch) {
  if (readerState.zoom === 'fit-width') {
    readerState.zoom = '200';
  } else {
    readerState.zoom = 'fit-width';
  }
  showZoomIndicator(zoomLabel(readerState.zoom));
  reloadContent();
}

function reloadContent() {
  if (readerState.comic.ext === 'pdf') pdfDoc = null;
  if (readerState.mode === 'scroll') {
    readerState.renderedPages.clear();
    const vp = document.getElementById('readerViewport');
    vp.querySelectorAll('.scroll-page').forEach(el => { el.innerHTML = el.dataset.page <= 3 ? '<div class="scroll-page-placeholder" style="aspect-ratio:3/4;background:rgba(255,255,255,0.02)"></div>' : ''; });
    if (readerState.scrollObserver) readerState.scrollObserver.disconnect();
    loadScrollMode();
  } else {
    loadPage();
  }
}

function zoomToScale(z) {
  if (z === 'fit-width') return 1;
  if (z === 'fit-height') return 0.8;
  return parseInt(z) / 100;
}

function zoomLabel(z) {
  if (z === 'fit-width') return '适应宽度';
  if (z === 'fit-height') return '适应高度';
  return z + '%';
}

// ── 键盘快捷键 ──

document.addEventListener('keydown', (e) => {
  if (!readerState) return;

  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      readerState.direction === 'rtl' ? prevPage() : nextPage();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      readerState.direction === 'rtl' ? nextPage() : prevPage();
      break;
    case 'ArrowDown':
    case ' ':
      e.preventDefault();
      nextPage();
      break;
    case 'ArrowUp':
      e.preventDefault();
      prevPage();
      break;
    case 'f':
    case 'F':
      toggleFullscreen();
      break;
    case 'd':
    case 'D':
      toggleMode();
      break;
    case 'Escape':
      closeReader();
      break;
    case '+':
    case '=':
      e.preventDefault();
      zoomIn();
      break;
    case '-':
      e.preventDefault();
      zoomOut();
      break;
    case '0':
      e.preventDefault();
      changeZoom('fit-width');
      break;
  }
});

function zoomIn() {
  const levels = ['fit-width', 'fit-height', '100', '150', '200'];
  const idx = levels.indexOf(readerState.zoom);
  if (idx < levels.length - 1) changeZoom(levels[idx + 1]);
}

function zoomOut() {
  const levels = ['fit-width', 'fit-height', '100', '150', '200'];
  const idx = levels.indexOf(readerState.zoom);
  if (idx > 0) changeZoom(levels[idx - 1]);
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

// ── 点击切换控制栏 ──

document.addEventListener('click', (e) => {
  if (!readerState) return;
  // 不处理按钮和滑块的点击
  if (e.target.closest('button') || e.target.closest('input')) return;

  readerState.controlsVisible = !readerState.controlsVisible;
  const topbar = document.getElementById('readerTopbar');
  const bottombar = document.getElementById('readerBottombar');
  if (readerState.controlsVisible) {
    topbar?.classList.remove('hidden');
    bottombar?.classList.remove('hidden');
  } else {
    topbar?.classList.add('hidden');
    bottombar?.classList.add('hidden');
  }
});

// ── 加载 pdf.js（本地优先，CDN 兜底）──
// 修复：原来死磕 cdnjs。NAS 断外网、或手机连的是纯内网 WiFi 时，
// PDF 永远停在"加载中"，而且控制台只有一行 load failed，很难查。
// 现在先用服务端自带的 /vendor/pdfjs 副本，拿不到再回退 CDN。
// 另外原来同时用 <script type=module> + import()，等于把 1.7MB 下了两遍。
(function loadPdfJs() {
  var LOCAL = '/vendor/pdfjs';
  var CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38';

  function tryLoad(base) {
    return import(base + '/pdf.min.mjs').then(function (mod) {
      var lib = (mod && mod.getDocument) ? mod : (mod && mod.default) || mod;
      if (!lib || !lib.getDocument) throw new Error('模块结构异常');
      lib.GlobalWorkerOptions.workerSrc = base + '/pdf.worker.min.mjs';
      pdfjsLib = lib;
      console.log('[pdf.js] 已从', base, '加载');
      return lib;
    });
  }

  tryLoad(LOCAL)
    .catch(function (e) {
      console.warn('[pdf.js] 本地副本加载失败，回退 CDN：', e && e.message);
      return tryLoad(CDN);
    })
    .catch(function (e) {
      console.error('[pdf.js] 加载彻底失败，PDF 将无法阅读：', e);
    });
})();

// ── EPUB 阅读器 ────────────────────────────────────

let epubState = null;

async function openEpubReader(comic) {
  // 获取目录
  let toc = [];
  try {
    const res = await api(`/api/comic/${comic.id}/epub/toc`);
    const data = await res.json();
    toc = data.toc || [];
  } catch (err) {
    console.error('EPUB TOC load failed:', err);
  }

  epubState = {
    comic,
    toc,
    currentChapter: 0,
    fontSize: 18,
    lineHeight: 1.8,
    fontFamily: 'serif',   // serif | sans
    theme: 'dark',         // dark | sepia | light
    sidebarOpen: false,
    controlsVisible: true,
  };

  // 尝试恢复进度
  try {
    const info = await ComicAPI.getComicInfo(comic.id);
    if (info.progress && info.progress.page > 0) {
      epubState.currentChapter = info.progress.page - 1;
      if (epubState.currentChapter >= toc.length) epubState.currentChapter = 0;
    }
  } catch {}

  buildEpubUI();
  loadEpubChapter();
}

function buildEpubUI() {
  const container = document.getElementById('reader');
  container.innerHTML = `
    <div class="epub-reader" id="epubReader">
      <div class="epub-topbar" id="epubTopbar">
        <button class="back-btn" onclick="closeEpubReader()" title="返回">←</button>
        <span class="comic-title">${escHtml(epubState.comic.name)}</span>
        <span class="chapter-info" id="epubChapterInfo"></span>
        <button class="tool-btn" id="epubBtnBookmark" onclick="epubToggleBookmark()" title="收藏">☆</button>
        <button class="tool-btn" onclick="epubToggleSidebar()" title="目录">☰</button>
      </div>
      <div class="epub-body">
        <div class="epub-sidebar" id="epubSidebar">
          <div class="epub-sidebar-header"><span>目录</span><button class="tool-btn" onclick="epubToggleSidebar()">✕</button></div>
          <div class="epub-toc" id="epubToc"></div>
        </div>
        <div class="epub-content-wrapper" id="epubContentWrapper">
          <div class="epub-tap-zone prev" onclick="epubPrevChapter()"></div>
          <div class="epub-content"><iframe id="epubFrame" sandbox="allow-same-origin" style="width:100%;height:100%;border:none;"></iframe></div>
          <div class="epub-tap-zone next" onclick="epubNextChapter()"></div>
        </div>
      </div>
      <div class="epub-bottombar" id="epubBottombar">
        <button class="bottombar-btn" onclick="epubFontSize(-2)">A-</button>
        <span class="epub-font-label" id="epubFontLabel">18px</span>
        <button class="bottombar-btn" onclick="epubFontSize(2)">A+</button>
        <span class="epub-sep">|</span>
        <button class="bottombar-btn" onclick="epubLineHeight(-0.2)">↕-</button>
        <span class="epub-font-label" id="epubLineLabel">1.8</span>
        <button class="bottombar-btn" onclick="epubLineHeight(0.2)">↕+</button>
        <span class="epub-sep">|</span>
        <button class="bottombar-btn" onclick="epubCycleFont()" id="epubFontBtn" title="字体">f</button>
        <button class="bottombar-btn" onclick="epubCycleTheme()" id="epubThemeBtn" title="主题">◐</button>
        <span style="flex:1"></span>
        <div class="epub-progress" id="epubProgress"></div>
        <button class="bottombar-btn" onclick="epubPrevChapter()">◀</button>
        <button class="bottombar-btn" onclick="epubNextChapter()">▶</button>
      </div>
    </div>
  `;
  container.style.display = 'flex';
  document.body.classList.add('reader-mode');
  renderEpubToc();
}

function renderEpubToc() {
  const tocEl = document.getElementById('epubToc');
  if (!tocEl) return;
  let html = '';
  epubState.toc.forEach((ch, i) => {
    html += `<div class="epub-toc-item${i === epubState.currentChapter ? ' active' : ''}" onclick="epubJumpToChapter(${i})">
      <span class="epub-toc-index">${i + 1}</span>
      <span class="epub-toc-title">${escHtml(ch.title)}</span>
    </div>`;
  });
  tocEl.innerHTML = html;
}

async function loadEpubChapter() {
  const chapter = epubState.toc[epubState.currentChapter];
  if (!chapter) return;

  document.getElementById('epubChapterInfo').textContent = `${epubState.currentChapter + 1} / ${epubState.toc.length}`;
  document.getElementById('epubProgress').textContent = `${epubState.currentChapter + 1} / ${epubState.toc.length}`;

  const frame = document.getElementById('epubFrame');
  try {
    const res = await api(`/api/comic/${epubState.comic.id}/epub/chapter/${epubState.currentChapter}`);
    const html = await res.text();
    frame.srcdoc = html;
  } catch {
    frame.srcdoc = '<body style="background:#1a1a22;color:#e8e8ec;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><p>章节加载失败</p></body>';
  }

  renderEpubToc();
  updateEpubBookmarkBtn();
  ComicAPI.saveProgress(epubState.comic.id, epubState.currentChapter + 1, epubState.toc.length).catch(() => {});
}

function epubNextChapter() { if (epubState.currentChapter < epubState.toc.length - 1) { epubState.currentChapter++; loadEpubChapter(); } }
function epubPrevChapter() { if (epubState.currentChapter > 0) { epubState.currentChapter--; loadEpubChapter(); } }
function epubJumpToChapter(index) { epubState.currentChapter = index; loadEpubChapter(); epubToggleSidebar(); }

function epubToggleSidebar() { epubState.sidebarOpen = !epubState.sidebarOpen; document.getElementById('epubSidebar').classList.toggle('open', epubState.sidebarOpen); }

function epubFontSize(delta) {
  epubState.fontSize = Math.max(10, Math.min(36, epubState.fontSize + delta));
  document.getElementById('epubFontLabel').textContent = epubState.fontSize + 'px';
  postEpubMsg({ type: 'fontSize', value: epubState.fontSize });
}

function epubLineHeight(delta) {
  epubState.lineHeight = Math.max(1.0, Math.min(3.0, +(epubState.lineHeight + delta).toFixed(1)));
  document.getElementById('epubLineLabel').textContent = epubState.lineHeight.toFixed(1);
  postEpubMsg({ type: 'lineHeight', value: epubState.lineHeight });
}

function epubCycleFont() {
  const fonts = ['serif', 'sans'];
  const names = ['"Iowan Old Style","Noto Serif SC",Georgia,serif', '-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'];
  const labels = ['宋体', '黑体'];
  const idx = fonts.indexOf(epubState.fontFamily);
  const next = (idx + 1) % fonts.length;
  epubState.fontFamily = fonts[next];
  document.getElementById('epubFontBtn').textContent = labels[next];
  postEpubMsg({ type: 'fontFamily', value: names[next] });
}

function epubCycleTheme() {
  const themes = ['dark', 'sepia', 'light'];
  const icons = { dark: '🌙', sepia: '📜', light: '☀️' };
  const idx = themes.indexOf(epubState.theme);
  epubState.theme = themes[(idx + 1) % themes.length];
  document.getElementById('epubThemeBtn').textContent = icons[epubState.theme];
  postEpubMsg({ type: 'theme', value: epubState.theme });
}

function postEpubMsg(msg) {
  const frame = document.getElementById('epubFrame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage(msg, '*');
  }
}

function epubToggleBookmark() { epubState.comic.bookmarked = !epubState.comic.bookmarked; updateEpubBookmarkBtn(); ComicAPI.toggleBookmark(epubState.comic.id).catch(() => {}); }
function updateEpubBookmarkBtn() { const btn = document.getElementById('epubBtnBookmark'); if (btn) btn.textContent = epubState.comic.bookmarked ? '★' : '☆'; }

function closeEpubReader() {
  const closingId = epubState ? epubState.comic.id : null;
  epubState = null;
  document.getElementById('reader').style.display = 'none';
  document.getElementById('reader').innerHTML = '';
  document.body.classList.remove('reader-mode');
  window._libraryNeedsRefresh = true;
  if (closingId && typeof showDetailForComic === 'function') showDetailForComic(closingId);
  else loadLibraryData();
}

document.addEventListener('keydown', (e) => {
  if (!epubState) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ': e.preventDefault(); epubNextChapter(); break;
    case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); epubPrevChapter(); break;
    case 'Escape': closeEpubReader(); break;
  }
});

// ── PDF 章节目录（仿 EPUB 侧边栏，前端 pdfDoc.getOutline） ──

async function loadPdfOutline() {
  if (!pdfDoc || !pdfState || pdfState.tocLoaded) return;
  pdfState.tocLoaded = true;
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return;
    const toc = [];
    await flattenPdfOutline(outline, 1, toc);
    pdfState.toc = toc;
    pdfState.hasToc = toc.length > 0;
    if (pdfState.hasToc) {
      const btn = document.getElementById('pdfBtnToc');
      if (btn) btn.style.display = '';
      renderPdfToc();
    }
  } catch (e) { /* 静默：无书签 / 解析失败不阻塞阅读 */ }
}

async function flattenPdfOutline(items, level, acc) {
  for (const it of items) {
    const page = await resolvePdfDest(it.dest);
    acc.push({ level, title: it.title || '', page });
    if (it.items && it.items.length) await flattenPdfOutline(it.items, level + 1, acc);
  }
}

async function resolvePdfDest(dest) {
  if (!dest) return 0;
  try {
    let resolved = dest;
    if (typeof dest === 'string') resolved = await pdfDoc.getDestination(dest);
    if (Array.isArray(resolved) && resolved[0]) {
      return (await pdfDoc.getPageIndex(resolved[0])) + 1;  // 1-based 页码
    }
    return 0;
  } catch { return 0; }
}

function renderPdfToc() {
  const tocEl = document.getElementById('pdfToc');
  if (!tocEl || !pdfState) return;
  const cur = readerState ? readerState.currentPage : 0;
  let activeIdx = -1;
  pdfState.toc.forEach((ch, i) => { if (ch.page && ch.page <= cur) activeIdx = i; });
  let html = '';
  pdfState.toc.forEach((ch, i) => {
    const indent = ' style="padding-left:' + (16 + (ch.level - 1) * 14) + 'px"';
    html += `<div class="pdf-toc-item${i === activeIdx ? ' active' : ''}"${indent} onclick="pdfJumpToChapter(${i})">
      <span class="pdf-toc-index">${ch.page || ''}</span>
      <span class="pdf-toc-title">${escHtml(ch.title)}</span>
    </div>`;
  });
  tocEl.innerHTML = html;
}

function pdfJumpToChapter(index) {
  const ch = pdfState && pdfState.toc[index];
  if (!ch || !ch.page || !readerState) return;
  const page = Math.max(1, Math.min(ch.page, readerState.totalPages || 99999));
  if (readerState.mode === 'scroll') {
    readerState.currentPage = page;
    updateUI();
    saveProgress();
    const t = document.getElementById('scroll-page-' + page);
    if (t) t.scrollIntoView({ behavior: 'auto' });
    else loadScrollMode();
  } else {
    jumpToPage(page);
  }
  pdfToggleSidebar(false);
}

function pdfToggleSidebar(force) {
  if (!pdfState) return;
  pdfState.sidebarOpen = typeof force === 'boolean' ? force : !pdfState.sidebarOpen;
  const sb = document.getElementById('pdfSidebar');
  if (sb) sb.classList.toggle('open', pdfState.sidebarOpen);
}

// ── 爱心点赞 ──
let likeState = { likes: 0, liked: false };

function toggleLikeComic() {
  if (!readerState && !epubState) return;
  const comic = readerState ? readerState.comic : epubState.comic;
  const btn = document.getElementById('btnLike');
  fetch(`/api/comic/${comic.id}/like`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } })
    .then(r => r.json()).then(d => {
      likeState = d;
      btn.textContent = d.liked ? '❤️' : '🤍';
      if (d.totalLikes > 0) btn.title = `${d.totalLikes}人喜欢`;
    }).catch(() => {});
}
