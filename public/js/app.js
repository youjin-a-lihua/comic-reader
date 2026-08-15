/**
 * fn-comic-reader · iOS 26 设计语言
 * 四 Tab：漫画 / 小说 / 全部 / 搜索
 * 玻璃拟态主题 · 自定义书架
 */

let allSeries = { comic: [], novel: [], all: [] };
let allComics = [];
let currentTab = 'comic';
let detailBackPage = 'comic';
let selectedTag = null;
let comicSortMode = localStorage.getItem('comic_sort') || 'series';
let novelSortMode = localStorage.getItem('novel_sort') || 'series';
let allSortMode = localStorage.getItem('all_sort') || 'series';
const collapsedSeries = new Set();
let selectedNovelTag = null;
let jmMode = 'id';
let astrbotAddress = '';
let activeFilters = new Set();
let allTags = [];
let userShelves = [];
let canDeleteComic = false; // 控制面板「允许删除漫画」开关（仅管理员拉取）

function $(id) { return document.getElementById(id); }

// ── 主题 ──
const THEMES = ['dark', 'light'];
let themeIdx = 0;

function initTheme() {
  const saved = localStorage.getItem('fn_comic_theme');
  if (saved && THEMES.includes(saved)) themeIdx = THEMES.indexOf(saved);
  applyTheme();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', THEMES[themeIdx]);
  const ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
  const ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>';
  const icons = { dark: ICON_MOON, light: ICON_SUN };
  document.querySelectorAll('[onclick*="cycleTheme"]').forEach(b => b.innerHTML = icons[THEMES[themeIdx]]);
}

function cycleTheme() {
  themeIdx = (themeIdx + 1) % THEMES.length;
  localStorage.setItem('fn_comic_theme', THEMES[themeIdx]);
  applyTheme();
}

// ── 初始化 ──
async function initApp() {
  const token = getToken();
  if (!token) { window.location.href = '/'; return; }
  initTheme();
  // 初始化 Gemini 双轨布局（防止 body 无 data-layout 时网格单列撑满）
  if (typeof currentLayout !== 'undefined') {
    document.body.setAttribute('data-layout', currentLayout);
    const layoutBtn = $('layoutToggleBtn');
    if (layoutBtn && typeof iconList !== 'undefined' && typeof iconGrid !== 'undefined') {
      layoutBtn.innerHTML = (currentLayout === 'spatial') ? iconList : iconGrid;
    }
  }
  let user = {};
  try {
    user = JSON.parse(localStorage.getItem('fn_comic_user') || '{}');
    if (user.username) {
      document.querySelectorAll('.user-avatar').forEach(av => {
        av.textContent = user.username.charAt(0).toUpperCase();
        if (user.role !== 'admin') av.style.display = 'none';
      });
    }
  } catch {}
  // 管理员拉取控制面板设置，决定是否显示「删除漫画」
  if (user && user.role === 'admin') {
    try {
      const r = await api('/api/admin/settings');
      if (r.ok) {
        const s = await r.json();
        canDeleteComic = !!s.allowDeleteComic;
      }
    } catch {}
  }
  await loadAllData();
}

// ── 数据加载 ──
async function loadAllData(force = false) {
  showSkeleton('comicGrid', 6);
  showSkeleton('novelGrid', 6);
  showSkeleton('allGrid', 8);

  try {
    const [resComic, resNovel, resAll] = await Promise.all([
      ComicAPI.getLibrary('comic', force),
      ComicAPI.getLibrary('novel', force),
      ComicAPI.getLibrary(null, force)
    ]);
    allSeries.comic = resComic.series || [];
    allSeries.novel = resNovel.series || [];
    allSeries.all = resAll.series || [];
    renderPage('comic');
  } catch (err) {
    if (err.message === '登录已过期') return;
  }
}

// ── 页面切换 ──
// 重量级标签页（整库网格）重复点击 / 快速切换极易在 iOS 上 OOM 崩溃（"网页将重新载入"）。
// 对策：① 同一标签不重建整页；② 渲染串行化，快速点击只保留最后一次目标，绝不叠加重建。
const _HEAVY_TABS = new Set(['comic', 'novel', 'all']);
let _lastRenderedHeavy = null;

// 切换重量级标签时，立即清空其它重量级网格、释放 DOM 与 blob 内存，
// 避免多个整库网格同时在 DOM 中叠加导致 iOS WebContent 被杀（"网页将重新载入"）。
function _clearGrid(id) {
  const g = document.getElementById(id);
  if (!g) return;
  if (g._gridObserver) { try { g._gridObserver.disconnect(); } catch (e) {} g._gridObserver = null; }
  g.querySelectorAll('img').forEach(im => { if (im.src && im.src.indexOf('blob:') === 0) { try { URL.revokeObjectURL(im.src); } catch (e) {} } });
  g.innerHTML = '';
  g._gstate = null;
}

function _updateNav(tab) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`[data-page="${tab}"]`);
  if (navItem) navItem.classList.add('active');
  const TITLES = { comic: '漫画', novel: '小说', all: '全库', online: '在线', profile: '我的空间', ranking: '排行榜', search: '搜索', detail: '详情' };
  const pt = document.getElementById('pageTitle');
  if (pt) pt.textContent = TITLES[tab] || '';
}

async function switchTab(tab) {
  currentTab = tab;
  _updateNav(tab);
  // 同一重量级标签重复点击：跳过整页重建（阅读进度刷新仍走 _libraryNeedsRefresh）
  if (_HEAVY_TABS.has(tab) && _lastRenderedHeavy === tab && !window._libraryNeedsRefresh) return;
  await renderPage(tab);
  _lastRenderedHeavy = tab;
}

function switchPage(tab) { switchTab(tab); } // 兼容旧调用

async function renderPage(tab) {
  // 阅读器关闭后需要刷新书架进度（"继续阅读"排序依赖最新数据）
  if (window._libraryNeedsRefresh) {
    window._libraryNeedsRefresh = false;
    await loadAllData();
    return;
  }
  // 隐藏所有页面
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  // 显示对应页面（如果有）
  const pageEl = document.getElementById('page-' + tab);
  if (pageEl) pageEl.classList.add('active');

  // 切换重量级标签时，立即清空其它重量级网格，释放 DOM/内存，避免多个整库网格叠加触发 iOS OOM
  if (_HEAVY_TABS.has(tab)) {
    const gridFor = { comic: 'comicGrid', novel: 'novelGrid', all: 'allGrid' }[tab];
    ['comicGrid', 'novelGrid', 'allGrid'].forEach(id => { if (id !== gridFor) _clearGrid(id); });
  }

  if (tab === 'comic') { renderTagCloud(); renderComicGridByTag(); renderRecommend(); }
  else if (tab === 'novel') { renderNovelTagCloud(); renderNovelGridByTag(); }
  else if (tab === 'all') {
    buildFilterBar(allSeries.all.flatMap(s => s.items));
    renderAllGrid();
    // 最近添加
    try {
      const res = await ComicAPI.getLibrary();
      if (res.recent && res.recent.length > 0) showRecentSection(res.recent, res.recentLabel);
    } catch {}
  }
  else if (tab === 'search') { renderRecentSearches(); }
  else if (tab === 'ranking') { await loadRanking('weekly'); }
  else if (tab === 'profile') { await renderProfile(); }
  else if (tab === 'online') { checkOnlineStatus(); }
}

// ── 在线模块是否启用（由后端 ONLINE_SOURCE 决定，默认关闭；开启后无需改动前端）──
let onlineEnabled = true; // 乐观默认，避免未拉取状态时误报「未启用」

async function checkOnlineStatus() {
  try {
    const res = await api('/api/online/status');
    const data = await res.json();
    onlineEnabled = !!data.enabled;
    const initial = document.getElementById('onlineInitial');
    if (!onlineEnabled && initial) {
      initial.innerHTML = `<p style="color:var(--muted,#888);text-align:center;padding:34px 14px;font-size:13px;line-height:1.9;">
        在线漫画模块未启用<br>
        在服务端设置环境变量 <code style="background:rgba(127,127,127,.15);padding:1px 6px;border-radius:4px;">ONLINE_SOURCE=jm</code> 并重启服务后即可开启<br>
        <span style="opacity:.7;font-size:12px;">详见 README「在线源（可插拔）」</span>
      </p>`;
    }
  } catch { /* 拉取失败时不改变既有状态 */ }
}

// ── 网格渲染 ──
function renderGrid(gridId, continueId, series) {
  const flat = series.flatMap(s => s.items);
  const grid = $(gridId);
  if (!grid) return;

  // 继续阅读 —— 按 lastUpdated 降序取最近阅读的一本
  const contEl = $(continueId);
  if (contEl) {
    const withProgress = flat
      .filter(c => c.progress && c.progress.page > 0)
      .sort((a, b) => new Date(b.progress.updatedAt || 0) - new Date(a.progress.updatedAt || 0))
      .slice(0, 1);
    if (withProgress.length > 0) {
      contEl.innerHTML = renderContinueCard(withProgress[0]);
      contEl.style.display = 'block';
    } else {
      contEl.style.display = 'none';
    }
  }

  if (flat.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>空空如也</p><p class="hint">将文件放入漫画目录即可自动发现</p></div>';
    return;
  }

  let html = '';
  for (const s of series) {
    html += `<div class="series-header"><h2>${escHtml(s.name)}</h2><span class="count">${s.count} 本</span></div>`;
    html += s.items.map((c, i) => renderComicCard(c, i * 0.03)).join('');
  }
  // 释放上一轮网格中的 blob 封面，防止内存泄漏累积（iOS OOM 崩溃主因之一）
  grid.querySelectorAll('img').forEach(im => { if (im.src && im.src.indexOf('blob:') === 0) { try { URL.revokeObjectURL(im.src); } catch (e) {} } });
  grid.innerHTML = html;
  setTimeout(loadPdfCovers, 500);
}

// ── 继续阅读大卡片 ──
function renderContinueCard(comic) {
  const pct = comic.progress && comic.progress.totalPages > 0
    ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;
  const authorStr = (comic.authors || []).slice(0, 2).join('、');
  const coverUrl = ComicAPI.getCoverUrl(comic.id);
  const typeLabel = comic.type === 'novel' ? '第' + comic.progress.page + '章' : comic.progress.page + '/' + (comic.progress.totalPages || '?') + '页';

  return `<h2 class="section-title">继续阅读</h2>
    <div class="continue-card" onclick="openReaderById('${comic.id}')">
      <div class="continue-cover">
        <img src="${coverUrl}" alt="" loading="lazy" 
          onerror="this.parentElement.innerHTML='<span class=placeholder>📖</span>'"
          ${getToken() ? `onload="this.setAttribute('data-loaded','1')"` : ''}>
      </div>
      <div class="continue-info">
        <div class="title">${escHtml(comic.name)}</div>
        ${authorStr ? `<div class="author">${escHtml(authorStr)}</div>` : ''}
        <div class="meta">${pct}% · ${typeLabel}</div>
        <div class="continue-progress-bar"><div class="fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
}

// ── 封面卡片 ──
function renderComicCard(comic, delay = 0) {
  const authorStr = (comic.authors || []).slice(0, 2).join('、');
  const coverUrl = ComicAPI.getCoverUrl(comic.id); // 始终尝试加载，token 已内置
  const progressPct = comic.progress && comic.progress.totalPages > 0
    ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;

  const meta = parseMangaMeta(comic.name);
  const title = meta.title || comic.name;
  const titleAuthor = (comic.authors && comic.authors.length > 0) ? comic.authors.slice(0,2).join('、') : meta.author;
  return `<div class="manga-card" style="animation-delay:${delay}s"
    onclick="openComicById('${comic.id}')"
    oncontextmenu="event.preventDefault();showComicMenu(event,'${comic.id}')">
    <div class="manga-cover-wrap">
      ${coverUrl ? `<img src="${coverUrl}" class="manga-cover" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>📖</div>'">`
        : `<div class="placeholder-cover">${escHtml(comic.name.slice(0, 2))}</div>`}
      ${progressPct > 0 ? `<div class="progress-indicator"><div class="fill" style="width:${progressPct}%"></div></div>` : ''}
      ${comic.bookmarked ? '<div class="badge-bookmark">★</div>' : ''}
      ${comic.isTranslated ? '<div class="badge-translated">译</div>' : ''}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(title)}</div>
      ${titleAuthor ? `<div class="author">✎ ${escHtml(titleAuthor)}</div>` : ''}
    </div>
  </div>`;
}

// ── 长按菜单 ──
function showComicMenu(event, comicId) {
  event.preventDefault();
  const comic = allComics.flatMap(s => s.items).find(c => c.id === comicId);
  if (!comic) return;

  // 简单书架选择
  const shelves = userShelves.filter(s => !s.items.includes(comicId));
  let shelfOpts = shelves.map(s => `<div onclick="addToShelf('${s.id}','${comicId}')">+ ${escHtml(s.name)}</div>`).join('');

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-menu-content">
      <div class="menu-title">${escHtml(comic.name.slice(0, 20))}</div>
      <div onclick="toggleBookmarkComic('${comicId}')">${comic.bookmarked ? '★ 取消收藏' : '☆ 加入收藏'}</div>
      <div onclick="openReaderById('${comicId}')">📖 开始阅读</div>
      ${shelfOpts ? '<hr>' + shelfOpts : ''}
      <div onclick="showCreateShelf('${comicId}')">+ 新建书架并加入</div>
      ${canDeleteComic ? '<hr><div style="color:#ff453a;font-weight:500" onclick="deleteComic(\'' + comicId + '\')">🗑 删除漫画（不可恢复）</div>' : ''}
      <hr><div onclick="this.parentElement.parentElement.remove()">取消</div>
    </div>
  `;
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  document.body.appendChild(menu);
  setTimeout(() => menu.classList.add('show'), 10);
  document.addEventListener('click', () => menu.remove(), { once: true });
}

// ── 一键删除漫画（管理员 + 控制面板开关）──
async function deleteComic(id) {
  const comic = (allComics.length ? allComics : Object.values(allSeries))
    .flatMap(s => (s.items || []))
    .find(c => c.id === id);
  const name = comic ? comic.name : id;
  if (!confirm('确定删除《' + name + '》？\n\n将永久删除：漫画文件本体 + 封面 + 全部元数据（进度/收藏/浏览/点赞/评论/书架），不可恢复！')) return;
  try {
    const r = await api('/api/comic/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      toast('已删除：' + name);
      // 关闭可能打开的详情/菜单，并刷新书架
      const openMenu = document.querySelector('.context-menu');
      if (openMenu) openMenu.remove();
      await loadAllData(true);
    } else {
      alert(d.error || '删除失败');
    }
  } catch (e) {
    alert('删除失败：' + (e && e.message || e));
  }
}

// ── 筛选 ──
function toggleFilterPanel() {
  const panel = document.getElementById('filterPanel');
  if (!panel) return;
  panel.classList.toggle('open');
}

function buildFilterBar(comics) {
  const tagCount = {}, authorCount = {};
  for (const c of comics) {
    for (const t of c.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    for (const a of c.authors || []) authorCount[a] = (authorCount[a] || 0) + 1;
  }
  allTags = [
    ...Object.entries(tagCount).map(([n, c]) => ({ name: n, count: c, type: 'tag' })),
    ...Object.entries(authorCount).map(([n, c]) => ({ name: n, count: c, type: 'author' }))
  ].sort((a, b) => b.count - a.count);

  const chips = document.getElementById('filterChipsAll');
  if (!chips || allTags.length === 0) return;
  const section = document.getElementById('tagSectionBodyAll')?.closest('.tag-section');
  if (section) section.classList.toggle('collapsed', localStorage.getItem('tagCloud_section_collapsed_all') === '1');
  const countEl = document.getElementById('tagSectionCountAll');
  if (countEl) countEl.textContent = allTags.length;
  let html = '<button class="filter-chip active" onclick="clearFilters()">全部</button>';
  allTags.forEach((t) => {
    html += `<button class="filter-chip" data-tag="${escHtml(t.name)}" onclick="toggleFilter('${escHtml(t.name).replace(/'/g, "\\'")}')">${t.type === 'author' ? '✎ ' : ''}${escHtml(t.name)}<span class="count">${t.count}</span></button>`;
  });
  chips.innerHTML = html;
}

function toggleFilter(name) {
  activeFilters.has(name) ? activeFilters.delete(name) : activeFilters.add(name);
  document.querySelectorAll('.filter-chip[data-tag]').forEach(c => c.classList.toggle('active', activeFilters.has(c.dataset.tag)));
  document.querySelector('.filter-chip:not([data-tag])')?.classList.toggle('active', activeFilters.size === 0);
  document.getElementById('filterClear').style.display = activeFilters.size > 0 ? 'block' : 'none';
  applyFilters();
}

function clearFilters() {
  activeFilters.clear();
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  document.querySelector('.filter-chip:not([data-tag])')?.classList.add('active');
  document.getElementById('filterClear').style.display = 'none';
  applyFilters();
}

function applyFilters() {
  renderAllGrid();
}

// 全库页网格：按系列分组（默认）或按 mtime 降序（时间模式），并应用当前筛选
function renderAllGrid() {
  document.querySelectorAll('#page-all .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === allSortMode));
  let filtered = allSeries.all.flatMap(s => s.items);
  if (activeFilters.size > 0) {
    filtered = filtered.filter(c => {
      const items = [...(c.tags || []), ...(c.authors || [])];
      return Array.from(activeFilters).every(f => items.includes(f));
    });
  }
  if (allSortMode === 'time') {
    filtered = filtered.sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
    renderGrid('allGrid', 'continueAll', [{ name: '按时间', count: filtered.length, items: filtered }]);
    return;
  }
  const map = {};
  for (const c of filtered) {
    const k = c.series || '其他';
    if (!map[k]) map[k] = [];
    map[k].push(c);
  }
  const series = Object.entries(map).map(([n, items]) => ({ name: n, count: items.length, items }));
  renderGrid('allGrid', 'continueAll', series);
}

// ── 最近添加 ──
function showRecentSection(items, label) {
  const pageAll = document.getElementById('page-all');
  if (!pageAll) return;
  let sec = document.getElementById('recentSection');
  if (!sec) {
    sec = document.createElement('section');
    sec.id = 'recentSection';
    sec.style.marginBottom = '24px';
    const pc = pageAll.querySelector('.page-content');
    if (pc) pc.insertBefore(sec, pc.firstChild);
  }
  const title = label || '最近添加';
  const html = '<h2 class="section-title">' + title + '</h2><div class="library-grid">' +
    items.map((c, i) => renderComicCard(c, i * 0.03)).join('') + '</div>';
  sec.innerHTML = html;
  setTimeout(loadPdfCovers, 300);
}

// ── 排行榜 ──
let rankData = null;
let rankMode = 'weekly';

async function loadRanking(mode) {
  rankMode = mode;
  try {
    const res = await fetch('/api/ranking', { headers: { 'Authorization': `Bearer ${getToken()}` } });
    rankData = await res.json();
  } catch { rankData = { weekly: [], allTime: [] }; }
  renderRanking();
}

function switchRankTab(mode) {
  rankMode = mode;
  document.getElementById('rankTabWeek').classList.toggle('active', mode === 'weekly');
  document.getElementById('rankTabAll').classList.toggle('active', mode === 'allTime');
  loadRanking(mode);
}

function renderRanking() {
  const list = rankData?.[rankMode] || [];
  const el = document.getElementById('rankingList');
  if (!list.length) { el.innerHTML = '<div class="empty-state"><p>暂无数据</p><p class="hint">阅读后即可上榜</p></div>'; return; }
  el.innerHTML = list.map((item, i) => `
    <div class="rank-item" onclick="openComicById('${item.id}')">
      <div class="rank-num ${i < 3 ? 'top' + (i + 1) : ''}">${i + 1}</div>
      <div class="rank-cover"><img src="${ComicAPI.getCoverUrl(item.id)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22><rect fill=%22%23333%22 width=%2248%22 height=%2248%22/><text fill=%22%23888%22 x=%2224%22 y=%2228%22 text-anchor=%22middle%22 font-size=%2214%22>📖</text></svg>'"></div>
      <div class="rank-info">
        <div class="rank-title">${escHtml(item.name.slice(0, 35))}</div>
        <div class="rank-meta">❤️ ${item.likes || 0} · 👁 ${item.views || 0}</div>
      </div>
    </div>`).join('');
}

// ── 爱心（在阅读器调用）──
async function toggleLikeFromReader(comicId) {
  try {
    await fetch(`/api/comic/${comicId}/like`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } });
  } catch {}
}

// ── 搜索 ──
let searchTimer = null;
let recentSearches = JSON.parse(localStorage.getItem('fn_recent_searches') || '[]');

function renderRecentSearches() {
  const el = document.getElementById('recentSearches');
  if (!el) return;
  el.innerHTML = recentSearches.length > 0
    ? recentSearches.slice(0, 10).map(q => `<span class="recent-search-item" onclick="performSearch('${escHtml(q)}')">${escHtml(q)}</span>`).join('')
    : '<span style="color:var(--text-tertiary);font-size:13px">搜索漫画、小说、作者或标签</span>';
}

function clearSearch() {
  const inp = document.getElementById('searchInput');
  if (inp) inp.value = '';
  document.getElementById('searchClear').style.display = 'none';
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('searchInitial').style.display = 'block';
  document.getElementById('searchEmpty').style.display = 'none';
}

function onSearch() {
  clearTimeout(searchTimer);
  const q = document.getElementById('searchInput').value.trim();
  document.getElementById('searchClear').style.display = q ? 'flex' : 'none';
  if (!q) {
    document.getElementById('searchResults').style.display = 'none';
    document.getElementById('searchInitial').style.display = 'block';
    document.getElementById('searchEmpty').style.display = 'none';
    return;
  }
  searchTimer = setTimeout(() => performSearch(q), 300);
}

async function performSearch(q) {
  document.getElementById('searchInput').value = q;
  document.getElementById('searchClear').style.display = 'flex';
  document.getElementById('searchInitial').style.display = 'none';
  document.getElementById('searchEmpty').style.display = 'none';
  document.getElementById('searchResults').style.display = 'block';
  document.getElementById('searchGrid').innerHTML = renderSkeletonHtml(4);

  try {
    const results = await ComicAPI.search(q);
    if (results.length === 0) {
      document.getElementById('searchResults').style.display = 'none';
      document.getElementById('searchEmpty').style.display = 'flex';
    } else {
      document.getElementById('searchGrid').innerHTML = results.map((c, i) => renderComicCard(c, i * 0.04)).join('');
      setTimeout(loadPdfCovers, 500);
    }
    recentSearches = [q, ...recentSearches.filter(s => s !== q)].slice(0, 10);
    localStorage.setItem('fn_recent_searches', JSON.stringify(recentSearches));
  } catch (err) {
    if (err.message === '登录已过期') return;
    document.getElementById('searchGrid').innerHTML = '<div class="empty-state"><p>搜索失败</p></div>';
  }
}

// ── 自定义书架 ──
async function loadShelves() {
  try {
    userShelves = await ComicAPI.getShelves();
    renderShelvesPanel();
  } catch {}
}

function renderShelvesPanel() {
  const el = document.getElementById('shelvesList');
  if (!el) return;
  if (userShelves.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>还没有自定义书架</p><p class="hint">长按漫画封面 → 新建书架</p></div>';
    return;
  }
  el.innerHTML = userShelves.map(s => `
    <div class="shelf-item" onclick="openShelf('${s.id}')">
      <div class="shelf-previews">${(s.previews || []).map(p => `<div class="shelf-preview-cover">${p.hasCover ? `<img src="${ComicAPI.getCoverUrl(p.id)}" alt="">` : '📖'}</div>`).join('')}</div>
      <div class="shelf-name">${escHtml(s.name)}</div>
      <div class="shelf-count">${s.itemCount} 本</div>
    </div>
  `).join('');
}

async function addToShelf(shelfId, comicId) {
  await ComicAPI.updateShelf(shelfId, { addItem: comicId });
  document.querySelector('.context-menu')?.remove();
  await loadShelves();
}

function showCreateShelf(comicId) {
  const name = prompt('书架名称：');
  if (!name) return;
  (async () => {
    const res = await ComicAPI.createShelf(name);
    if (res.id && comicId) await ComicAPI.updateShelf(res.id, { addItem: comicId });
    document.querySelector('.context-menu')?.remove();
    await loadShelves();
  })();
}

async function openShelf(id) {
  try {
    const shelf = await ComicAPI.getShelf(id);
    const items = shelf.items || [];
    document.getElementById('shelvesList').innerHTML = '';
    const section = document.getElementById('shelvesContent');
    if (section) {
      section.innerHTML = `<h2>${escHtml(shelf.name)}</h2><div class="library-grid">${items.map((c, i) => renderComicCard(c, i * 0.03)).join('')}</div>`;
    }
  } catch {}
}

// ── 收藏切换 ──
async function toggleBookmarkComic(id) {
  await ComicAPI.toggleBookmark(id);
  await loadAllData();
}

// ── 打开漫画 ──
// 点开漫画 → 进入详情/系列枢纽页（而非直接进阅读器），
// 形成「书架 → 详情 → 阅读器」的自然返回栈。
function openComicById(id) {
  const flat = Object.values(allSeries).flatMap(s => s.flatMap(x => x.items));
  const comic = flat.find(c => c.id === id);
  if (!comic) return;

  // 记录阅读
  fetch(`/api/comic/${id}/view`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } }).catch(() => {});

  detailBackPage = currentTab || 'comic';
  renderDetail(comic);
  switchPage('detail');
}

// 从详情页 / 继续阅读 直达阅读器
function openReaderById(id) {
  const flat = Object.values(allSeries).flatMap(s => s.flatMap(x => x.items));
  const comic = flat.find(c => c.id === id);
  if (!comic) return;
  openReader(comic);
}

// 找到包含该漫画的系列（用于列出同系列其他卷）
function findSeriesOf(comic) {
  for (const key of Object.keys(allSeries)) {
    for (const s of allSeries[key]) {
      if (s.items && s.items.some(c => c.id === comic.id)) return s;
    }
  }
  return null;
}

// 渲染详情 / 系列枢纽页
function renderDetail(comic) {
  const series = findSeriesOf(comic);
  const siblings = (series && series.items) ? series.items : [comic];
  const coverUrl = ComicAPI.getCoverUrl(comic.id);
  const ext = comic.ext ? comic.ext.toUpperCase() : '';
  const pct = comic.progress && comic.progress.totalPages > 0
    ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;
  const startLabel = comic.progress && comic.progress.page > 0
    ? `继续阅读 <span class="sub">${comic.progress.page}/${comic.progress.totalPages || '?'} 页 · ${pct}%</span>`
    : '开始阅读';

  const tags = (comic.tags || []).map(t => `<span class="detail-tag">${escHtml(t)}</span>`).join('');

  let html = `
    <div class="detail-hero">
      <div class="detail-cover">
        <img src="${coverUrl}" alt="" loading="lazy"
          onerror="this.parentElement.innerHTML='<div class=placeholder-cover>📖</div>'">
      </div>
      <div class="detail-meta-col">
        <div class="detail-title">${escHtml(comic.name)}</div>
        ${series && series.name !== comic.name ? `<div class="detail-sub">系列：${escHtml(series.name)}</div>` : ''}
        ${ext ? `<div class="detail-sub">格式：${ext}</div>` : ''}
        ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
        <button class="detail-start" onclick="openReaderById('${comic.id}')">${startLabel}</button>
        ${canDeleteComic ? `<button class="detail-start" style="background:rgba(255,69,58,0.12);color:#ff453a;margin-top:10px" onclick="deleteComic('${comic.id}')">🗑 删除漫画（不可恢复）</button>` : ''}
      </div>
    </div>`;

  if (siblings.length > 0) {
    html += `<div class="detail-section-title">本系列共 ${siblings.length} 卷<span class="count">点击任意一卷开始阅读</span></div>`;
    html += '<div class="volume-list">';
    for (const vol of siblings) {
      const vpct = vol.progress && vol.progress.totalPages > 0
        ? Math.round((vol.progress.page / vol.progress.totalPages) * 100) : 0;
      const isActive = vol.id === comic.id;
      let stateCls = '', badge = '';
      if (vol.progress && vol.progress.page > 0) {
        if (vpct >= 100) { stateCls = 'read'; badge = '<span class="volume-badge read">已读</span>'; }
        else { stateCls = 'reading'; badge = '<span class="volume-badge">在读</span>'; }
      }
      const stateText = vpct > 0 ? `读到 ${vpct}%` : '未读';
      html += `
        <div class="volume-item ${isActive ? 'active' : ''}" onclick="openReaderById('${vol.id}')">
          <div class="volume-thumb">
            <img src="${ComicAPI.getCoverUrl(vol.id)}" alt="" loading="lazy"
              onerror="this.parentElement.innerHTML='<div class=placeholder-cover>📖</div>'">
          </div>
          <div class="volume-info">
            <div class="volume-name">${escHtml(vol.name)}</div>
            <div class="volume-state ${stateCls}">${stateText}</div>
          </div>
          ${badge}
        </div>`;
    }
    html += '</div>';
  }

  // 评论区
  html += `
    <div class="detail-section-title">评论区<span class="count">聊聊这本</span></div>
    <div class="comment-box">
      <input type="text" id="commentNick" class="comment-nick" placeholder="昵称（可空，默认匿名）" value="${escHtml(localStorage.getItem('fn_comment_nick') || '')}">
      <textarea id="commentText" class="comment-text" placeholder="说点什么…" rows="2"></textarea>
      <button class="comment-submit" onclick="submitComment('${comic.id}')">发表评论</button>
    </div>
    <div class="comment-list" id="detailComments"><div class="comment-empty">加载中…</div></div>`;

  const el = document.getElementById('detailContent');
  if (el) el.innerHTML = html;
  const titleEl = document.getElementById('detailTitle');
  if (titleEl) titleEl.textContent = comic.name.length > 16 ? comic.name.slice(0, 16) + '…' : comic.name;
  loadComments(comic.id);
}

// 阅读器退出后回到详情页（同系列）
function showDetailForComic(id) {
  const flat = Object.values(allSeries).flatMap(s => s.flatMap(x => x.items));
  const comic = flat.find(c => c.id === id);
  if (!comic) { loadAllData(); return; }
  renderDetail(comic);
  switchPage('detail');
}

// 详情页返回到来源书架页
function showDetailBack() {
  switchPage(detailBackPage || 'comic');
}

// 安卓返回键统一走此栈：阅读器 → 详情页 → 书架
window.fnComicBack = function () {
  const readerEl = document.getElementById('reader');
  if (readerEl && readerEl.style.display !== 'none') {
    closeReader();
    return 'reader';
  }
  const detailEl = document.getElementById('page-detail');
  if (detailEl && detailEl.classList.contains('active')) {
    showDetailBack();
    return 'detail';
  }
  return 'exit';
};

function loadLibraryData() { loadAllData(); } // reader 回调

// ── 标签云（漫画页顶部快速筛选，可折叠区块头） ──
function renderTagCloud() {
  const cloud = document.getElementById('filterChips');
  if (!cloud) return;
  const tagCount = {};
  for (const s of (allSeries.comic || [])) {
    for (const c of s.items) {
      for (const t of c.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);
  const section = document.getElementById('tagSectionBodyComic')?.closest('.tag-section');
  if (tags.length === 0) {
    cloud.style.display = 'none';
    if (section) section.style.display = 'none';
    return;
  }
  cloud.style.display = 'flex';
  if (section) {
    section.style.display = 'block';
    section.classList.toggle('collapsed', localStorage.getItem('tagCloud_section_collapsed_comic') === '1');
  }
  const countEl = document.getElementById('tagSectionCountComic');
  if (countEl) countEl.textContent = tags.length;
  let html = `<button class="tag-pill ${selectedTag ? '' : 'active'}" onclick="clearTagFilter()">全部</button>`;
  tags.forEach(([t, n]) => {
    html += `<button class="tag-pill ${selectedTag === t ? 'active' : ''}" onclick="toggleTagFilter('${escHtml(t).replace(/'/g, "\\'")}')">${escHtml(t)}<span class="count">${n}</span></button>`;
  });
  cloud.innerHTML = html;
}
function toggleTagSection(ctx) {
  const key = 'tagCloud_section_collapsed_' + ctx;
  const collapsed = !(localStorage.getItem(key) === '1');
  localStorage.setItem(key, collapsed ? '1' : '0');
  const bodyId = 'tagSectionBody' + ctx.charAt(0).toUpperCase() + ctx.slice(1);
  const section = document.getElementById(bodyId)?.closest('.tag-section');
  if (section) section.classList.toggle('collapsed', collapsed);
}
// 系列区块标题折叠（漫画/小说/全库通用）
function toggleSeriesSection(headerEl) {
  const section = headerEl.closest('.series-section');
  if (!section) return;
  const sid = section.dataset.sid;
  if (collapsedSeries.has(sid)) {
    collapsedSeries.delete(sid);
    section.classList.remove('collapsed');
    // 窗口化下，折叠系列可能尚未渲染卡片（被跳过），展开时按需填充
    const grid = section.closest('.series-container');
    const sg = section.querySelector('.series-grid');
    if (grid && sg && sg.children.length === 0 && grid._gstate && grid._gstate.bySid[sid]) {
      const s = grid._gstate.bySid[sid];
      sg.innerHTML = s.items.map((c, i) => renderSingleMangaCard(c, i)).join('');
      if (typeof loadPdfCovers === 'function') setTimeout(loadPdfCovers, 50);
    }
  } else {
    collapsedSeries.add(sid);
    section.classList.add('collapsed');
  }
}
// 推荐条横向滚动（桌面端箭头）
function scrollRow(btn, dir) {
  const row = btn.parentElement.querySelector('.rec-scroll');
  if (!row) return;
  row.scrollBy({ left: dir * Math.max(240, Math.round(row.clientWidth * 0.8)), behavior: 'smooth' });
}
// 标签轨道横向滚动（桌面端箭头）—— 真正可滚动的是内层 .filter-chips-track
function scrollTrack(bodyId, dir) {
  const track = document.getElementById(bodyId)?.querySelector('.filter-chips-track');
  if (!track) return;
  track.scrollBy({ left: dir * 240, behavior: 'smooth' });
}
function toggleTagFilter(tag) {
  selectedTag = (selectedTag === tag) ? null : tag;
  renderTagCloud();
  renderComicGridByTag();
}

// 漫画页排序切换：series = 按系列分组；time = 按 mtime 降序（最近添加/修改最前）
function setComicSort(mode) {
  comicSortMode = mode;
  try { localStorage.setItem('comic_sort', mode); } catch (e) {}
  renderComicGridByTag();
}
// 小说页排序切换
function setNovelSort(mode) {
  novelSortMode = mode;
  try { localStorage.setItem('novel_sort', mode); } catch (e) {}
  renderNovelGridByTag();
}
// 全库页排序切换
function setAllSort(mode) {
  allSortMode = mode;
  try { localStorage.setItem('all_sort', mode); } catch (e) {}
  renderAllGrid();
}
function clearTagFilter() {
  selectedTag = null;
  renderTagCloud();
  renderComicGridByTag();
}
function renderComicGridByTag() {
  // 同步排序切换条的选中态
  document.querySelectorAll('#page-comic .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === comicSortMode));
  let series;
  if (!selectedTag) {
    series = allSeries.comic;
  } else {
    series = (allSeries.comic || []).map(s => ({
      ...s,
      items: s.items.filter(c => (c.tags || []).includes(selectedTag))
    })).filter(s => s.items.length > 0);
  }
  // 按时间排序：打平为单序列，按 mtime 降序（最近添加/修改的排最前）
  if (comicSortMode === 'time') {
    const flat = series.flatMap(s => s.items)
      .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
    renderGrid('comicGrid', 'continueComic', [{ name: '按时间', count: flat.length, items: flat }]);
    return;
  }
  renderGrid('comicGrid', 'continueComic', series);
}

// ── 个性化推荐：猜你喜欢 / 今日推荐（纯前端） ──
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}
async function computeRecommend(username) {
  try {
    const continueList = await ComicAPI.getContinue();
    const viewedIds = new Set((continueList || []).map(c => c.id));
    const idToTags = {}, idToComic = {};
    for (const s of (allSeries.comic || [])) {
      for (const c of s.items) { idToTags[c.id] = c.tags || []; idToComic[c.id] = c; }
    }
    const tagWeight = {};
    const now = Date.now();
    for (const v of (continueList || [])) {
      const tags = idToTags[v.id] || [];
      const days = Math.max(0, (now - new Date(v.updatedAt || now).getTime()) / 86400000);
      const w = 1 / (days + 1);
      for (const t of tags) tagWeight[t] = (tagWeight[t] || 0) + w;
    }
    const scored = [];
    for (const [id, c] of Object.entries(idToComic)) {
      if (viewedIds.has(id)) continue;
      let score = 0;
      for (const t of (c.tags || [])) score += (tagWeight[t] || 0);
      if (score > 0) scored.push({ comic: c, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 12).map(s => s.comic);
  } catch (e) {
    console.error('computeRecommend failed', e);
    return [];
  }
}
async function renderRecommend() {
  const strip = document.getElementById('recommendStrip');
  if (!strip) return;
  const user = JSON.parse(localStorage.getItem('fn_comic_user') || '{}');
  if (!user.username) { strip.style.display = 'none'; return; }
  const recs = await computeRecommend(user.username);
  if (!recs || recs.length === 0) { strip.style.display = 'none'; return; }
  strip.style.display = 'block';
  const todayKey = new Date().toISOString().slice(0, 10);
  const seed = hashStr(todayKey);
  const pickN = Math.min(3, recs.length);
  const used = new Set();
  const picks = [];
  for (let i = 0; i < pickN; i++) {
    const idx = (seed + i * 7) % recs.length;
    if (!used.has(idx)) { used.add(idx); picks.push(recs[idx]); }
  }
  const rest = [];
  for (let i = 0; i < recs.length; i++) if (!used.has(i)) rest.push(recs[i]);
  const ordered = picks.concat(rest);
  let html = '<div class="rec-head"><h2 class="section-title">猜你喜欢</h2>';
  html += `<span class="rec-today">今日精选 ${pickN} 本</span></div>`;
  html += '<div class="rec-scroll-row">';
  html += `<button class="scroll-btn" onclick="scrollRow(this, -1)" aria-label="向左"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg></button>`;
  html += '<div class="rec-scroll">';
  ordered.forEach((c, i) => {
    const today = i < picks.length;
    html += `<div class="rec-cell ${today ? 'rec-cell--today' : ''}">${renderSingleMangaCard(c, i)}${today ? '<span class="rec-badge">今日精选</span>' : ''}</div>`;
  });
  html += '</div>';
  html += `<button class="scroll-btn" onclick="scrollRow(this, 1)" aria-label="向右"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg></button>`;
  html += '</div>';
  strip.innerHTML = html;
}

// ── 评论区 ──
async function loadComments(comicId) {
  const el = document.getElementById('detailComments');
  if (!el) return;
  try {
    const list = await ComicAPI.getComments(comicId);
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="comment-empty">还没有评论，来抢沙发～</div>';
      return;
    }
    el.innerHTML = list.slice().reverse().map(c => `
      <div class="comment-item">
        <div class="comment-head"><span class="comment-name">${escHtml(c.name || '匿名')}</span><span class="comment-time">${fmtCommentTime(c.ts)}</span></div>
        <div class="comment-body">${escHtml(c.text)}</div>
      </div>`).join('');
  } catch {
    el.innerHTML = '<div class="comment-empty">评论加载失败</div>';
  }
}
function fmtCommentTime(ts) {
  try {
    const d = new Date(ts), diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return d.toLocaleDateString('zh-CN');
  } catch { return ''; }
}
async function submitComment(comicId) {
  const nickEl = document.getElementById('commentNick');
  const textEl = document.getElementById('commentText');
  const text = textEl.value.trim();
  if (!text) { toast('评论内容不能为空'); return; }
  const name = nickEl ? nickEl.value.trim() : '';
  if (nickEl) localStorage.setItem('fn_comment_nick', nickEl.value);
  try {
    await ComicAPI.postComment(comicId, { name, text });
    textEl.value = '';
    await loadComments(comicId);
    toast('评论已发表');
  } catch {
    toast('评论发表失败');
  }
}

// ── AstrBot 联动（后端代理真实触发，凭据存服务端） ──
function getAstrbotUrl() { return astrbotAddress; }
async function openJmDownload() {
  const modal = document.getElementById('jmModal');
  if (!modal) return;
  const r = document.getElementById('jmResult');
  if (r) r.style.display = 'none';
  try {
    const cfg = await ComicAPI.getAstrbotConfig();
    if (cfg.address) astrbotAddress = cfg.address;
    const url = document.getElementById('jmUrl');
    if (url) url.value = cfg.address || '';
    const user = document.getElementById('jmUser');
    if (user) user.value = cfg.username || '';
    const pass = document.getElementById('jmPass');
    if (pass) pass.value = '';
  } catch {}
  const inp = document.getElementById('jmInput');
  if (inp) inp.value = '';
  renderJmSeg();
  // 保留上次选择的模式；首次或无效模式时默认 id
  if (!JM_MODES[jmMode]) jmMode = 'id';
  setJmMode(jmMode);
  modal.style.display = 'flex';
  setTimeout(() => inp && inp.focus(), 50);
}
function closeJmModal() {
  stopJmPoll();
  const modal = document.getElementById('jmModal');
  if (modal) modal.style.display = 'none';
}
// ── JM 下载指令模式表（含新增 /jmupdate 增量、/jmi 详情） ──
const JM_MODES = {
  id:   { cmd: 'jm',       label: '按 ID（/jm）',         hint: '本子 ID，如 123456',             ingest: true  },
  kw:   { cmd: 'jms',      label: '按关键词（/jms）',      hint: '关键词，支持 tag:全彩 / author:xxx / 第2页', ingest: true },
  upd:  { cmd: 'jmupdate', label: '增量更新（/jmupdate）', hint: '本子 ID，只下新增章节',           ingest: true  },
  info: { cmd: 'jmi',      label: '详情（/jmi）',          hint: '本子 ID，查看详情（不入库）',      ingest: false },
};
// 会话轮询状态
let jmPollTimer = null, jmPollSid = null, jmLastSnap = '', jmStableCount = 0, jmPollCount = 0;
function renderJmSeg() {
  const seg = document.getElementById('jmSeg');
  if (!seg || seg.dataset.built) return;
  seg.innerHTML = '';
  for (const [key, m] of Object.entries(JM_MODES)) {
    const b = document.createElement('button');
    b.className = 'seg-btn';
    b.id = 'jmMode_' + key;
    b.textContent = m.label;
    b.onclick = () => setJmMode(key);
    seg.appendChild(b);
  }
  seg.dataset.built = '1';
}
function buildJmCommand(mode, kw) {
  const q = (kw || '').trim();
  // 用户直接输入完整指令（如 /jmi 1453619）时直接透传，不再套一层 /jm
  if (q.startsWith('/')) return q;
  const m = JM_MODES[mode] || JM_MODES.id;
  return '/' + m.cmd + ' ' + q;
}
function setJmMode(mode) {
  jmMode = mode;
  document.querySelectorAll('#jmSeg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.id === 'jmMode_' + mode);
  });
  const inp = document.getElementById('jmInput');
  if (inp) inp.placeholder = (JM_MODES[mode] || JM_MODES.id).hint;
  updateJmPreview();
}
function updateJmPreview() {
  const inp = document.getElementById('jmInput');
  const kw = inp ? inp.value.trim() : '';
  const el = document.getElementById('jmPreview');
  if (el) el.textContent = buildJmCommand(jmMode, kw);
}
async function saveJmConfig() {
  const url = document.getElementById('jmUrl');
  const user = document.getElementById('jmUser');
  const pass = document.getElementById('jmPass');
  if (!url || !url.value.trim()) { toast('请填写 AstrBot 地址'); return; }
  let existPass = '';
  try { const c = await ComicAPI.getAstrbotConfig(); existPass = c.password || ''; } catch {}
  const newPass = (pass && pass.value) ? pass.value : existPass;
  const res = await ComicAPI.saveAstrbotConfig({ address: url.value.trim(), username: user ? user.value.trim() : '', password: newPass });
  if (res && res.status === 'ok') { astrbotAddress = url.value.trim(); toast('AstrBot 配置已保存'); }
  else toast('保存失败：' + ((res && res.message) || '未知错误'));
}
async function copyJmCommand() {
  const inp = document.getElementById('jmInput');
  const kw = inp ? inp.value.trim() : '';
  if (!kw) { toast('请先输入 JM ID 或关键词'); return; }
  const cmd = buildJmCommand(jmMode, kw);
  try {
    await navigator.clipboard.writeText(cmd);
    toast('已复制：' + cmd + '（也可直接点“发送指令”）');
  } catch {
    const el = document.getElementById('jmPreview');
    if (el) { const rg = document.createRange(); rg.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(rg); }
    toast('请手动复制：' + cmd);
  }
}
function isJmIngestCommand(command) {
  // 根据实际指令判断是否会落盘入库；查询类（jmi/jmrank/jmrec 等）不入库
  const cmd = (command || '').trim().split(/\s+/)[0].toLowerCase();
  return ['/jm', '/jms', '/jmc', '/jmfavdl', '/jmupdate'].includes(cmd);
}
async function sendJmCommand() {
  const inp = document.getElementById('jmInput');
  const kw = inp ? inp.value.trim() : '';
  if (!kw) { toast('请先输入 JM ID 或关键词'); return; }
  const btn = document.getElementById('jmSendBtn');
  const r = document.getElementById('jmResult');
  const command = buildJmCommand(jmMode, kw);
  const ingest = isJmIngestCommand(command);
  if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
  stopJmPoll();
  try {
    const res = await ComicAPI.sendAstrbotCommand({ command });
    if (r) r.style.display = 'block';
    if (res.status !== 'ok') {
      if (r) { r.className = 'jm-result err'; r.textContent = '⚠️ ' + (res.message || '发送失败') + '（可改用“复制指令”手动发送）'; }
      toast(res.message || '发送失败');
      return;
    }
    if (!res.sessionId) {
      // 兜底：老接口未返回 sessionId，仅展示首条回复
      if (r) { r.className = 'jm-result ok'; r.innerHTML = '✅ 已发送：<b>' + escHtml(res.command) + '</b>' + (res.reply ? '<br>Bot：' + escHtml(res.reply).replace(/\n/g, '<br>') : ''); }
      return;
    }
    jmPollSid = res.sessionId;
    jmLastSnap = ''; jmStableCount = 0; jmPollCount = 0;
    await pollJmSession(ingest);
    jmPollTimer = setInterval(() => pollJmSession(ingest), 1500);
  } catch (e) {
    if (r) { r.style.display = 'block'; r.className = 'jm-result err'; r.textContent = '⚠️ 网络错误：' + e; }
    toast('网络错误');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '发送指令'; }
  }
}
function stopJmPoll() {
  if (jmPollTimer) { clearInterval(jmPollTimer); jmPollTimer = null; }
  jmPollSid = null;
}
async function pollJmSession(ingest) {
  if (!jmPollSid) return;
  const r = document.getElementById('jmResult');
  if (!r) return;
  let data;
  try {
    const res = await ComicAPI.getAstrbotSession(jmPollSid);
    if (!res || res.status !== 'ok') return;
    data = res.messages || [];
  } catch { return; }
  renderJmSession(data, ingest);
  // 结束条件：done 关键词 / 快照稳定（查询类）/ 超时上限
  const allText = data.filter(m => m.role === 'bot' && m.type === 'text').map(m => m.text || '').join('\n');
  const done = /(完成|入库|已下载|下载成功|成功收编|已入库|已加入)/.test(allText);
  const snap = JSON.stringify(data);
  if (snap === jmLastSnap) jmStableCount++; else jmStableCount = 0;
  jmLastSnap = snap;
  jmPollCount++;
  const stableStop = !ingest && jmStableCount >= 3;   // 查询类：内容稳定即停
  const timeoutStop = jmPollCount >= 80;              // 硬上限 ~120s
  if (done || stableStop || timeoutStop) stopJmPoll();
}
function renderJmSession(messages, ingest) {
  const r = document.getElementById('jmResult');
  if (!r) return;
  r.className = 'jm-result ok';
  if (ingest) {
    const botTexts = messages.filter(m => m.role === 'bot' && m.type === 'text').map(m => m.text || '').filter(Boolean);
    const allText = botTexts.join('\n');
    let pct = 0;
    const m = allText.match(/(\d{1,3})%/g);
    if (m) pct = Math.max(...m.map(x => parseInt(x)));
    const done = /(完成|入库|已下载|下载成功|成功收编|已入库|已加入)/.test(allText);
    let html = '<div class="jm-progress"><div class="jm-progress-bar" style="width:' + pct + '%"></div></div>';
    html += '<div class="jm-progress-label">' + (done ? '✅ 完成' + (ingest ? '，刷新书架即可看到' : '') : (pct > 0 ? ('下载中 ' + pct + '%') : '任务已提交，等待 Bot 响应…')) + '</div>';
    html += '<div class="jm-log">';
    for (const t of botTexts) html += '<div>' + escHtml(t).replace(/\n/g, '<br>') + '</div>';
    html += '</div>';
    r.innerHTML = html;
  } else {
    const imgs = messages.filter(m => m.type === 'image');
    const botTexts = messages.filter(m => m.role === 'bot' && m.type === 'text').map(m => m.text || '').filter(Boolean);
    let html = '';
    if (imgs.length) {
      const c = imgs[0];
      html += '<div class="jm-detail-cover"><img src="/api/astrbot/attachment/' + encodeURIComponent(jmPollSid) + '/' + encodeURIComponent(c.attachmentId) + '?token=' + encodeURIComponent(getToken() || '') + '" loading="lazy" alt="cover"></div>';
    }
    html += '<div class="jm-detail-meta">';
    for (const t of botTexts) html += '<div class="jm-detail-line">' + escHtml(t).replace(/\n/g, '<br>') + '</div>';
    html += '</div>';
    r.innerHTML = html;
  }
}
function openAstrbot() {
  const url = astrbotAddress;
  if (window.__fnAndroidBridge && window.__fnAndroidBridge.openExternal) {
    window.__fnAndroidBridge.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
}
function openLocalSearch() {
  switchPage('search');
  setTimeout(() => {
    const inp = document.getElementById('searchInput');
    if (inp) { inp.focus(); toast('已在本地漫画库搜索，输入关键词试试'); }
  }, 120);
}

// ── 轻量 toast ──
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('fnToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ── 骨架屏 ──
function showSkeleton(gridId, count) {
  const el = document.getElementById(gridId);
  if (!el) return;
  el.innerHTML = renderSkeletonHtml(count);
}

function renderSkeletonHtml(count = 6) {
  return '<div class="skeleton-grid">' + Array(count).fill(0).map((_, i) =>
    `<div class="skeleton-card" style="animation-delay:${i*0.05}s"><div class="skeleton-cover" style="animation-delay:${i*0.1}s"></div><div class="skeleton-title" style="animation-delay:${i*0.12}s"></div></div>`
  ).join('') + '</div>';
}

// ── 个人中心 ──

// 防止漫画盘(sda)偶发 I/O 卡顿时前端永远卡在"加载中…"：加超时 + 可重试
const PROFILE_TIMEOUT_MS = 15000;

function renderProfileTimeout(el) {
  el.innerHTML = '<div class="empty-state"><p>加载超时</p>' +
    '<p class="hint">漫画盘可能暂时性 I/O 繁忙（磁盘偶发错误），点下方按钮重试</p>' +
    '<button class="action-btn" onclick="renderProfile()">重试</button></div>';
}

async function renderProfile() {
  const el = $('profileContent');
  if (!el) return;

  // 先显式进入加载态，保证超时兜底一定能替换占位
  el.innerHTML = '<div class="profile-loading">加载中...</div>';

  const timer = setTimeout(() => renderProfileTimeout(el), PROFILE_TIMEOUT_MS);
  try {
    const [bookmarks, recent] = await Promise.all([
      ComicAPI.getBookmarks(),
      ComicAPI.getContinue()
    ]);
    clearTimeout(timer);
    renderProfileContent(el, bookmarks, recent);
    // === 任务 B 补全：加载并渲染自定义书架 ===
    userShelves = await ComicAPI.getShelves();
    if (typeof renderShelvesPanel === 'function') renderShelvesPanel();
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && e.message) ? e.message : '加载失败';
    el.innerHTML = '<div class="empty-state"><p>' + msg + '</p>' +
      '<p class="hint">请稍后重试</p>' +
      '<button class="action-btn" onclick="renderProfile()">重试</button></div>';
  }
}

function renderProfileContent(container, bookmarks, recent) {
  let html = '';

  // 收藏
  html += '<h2 class="section-title">收藏 <span class="count">' + bookmarks.length + ' 本</span></h2>';
  if (bookmarks.length > 0) {
    html += '<div class="library-grid profile-grid">';
    html += bookmarks.map((c, i) => renderComicCard({ ...c, progress: c.progress || null, bookmarked: true }, i * 0.03)).join('');
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>还没有收藏</p><p class="hint">阅读时长按漫画或点 ★ 即可收藏</p></div>';
  }

  // 最近观看（排除已完结的）
  const watching = recent.filter(c => c.progress && c.progress.page > 0);
  html += '<h2 class="section-title" style="margin-top:24px">最近观看 <span class="count">' + watching.length + ' 本</span></h2>';
  if (watching.length > 0) {
    html += '<div class="profile-list">';
    html += watching.map(c => {
      const pct = c.progress && c.progress.totalPages > 0
        ? Math.round((c.progress.page / c.progress.totalPages) * 100) : 0;
      const coverUrl = ComicAPI.getCoverUrl(c.id);
      const authorStr = (c.authors || []).slice(0, 1).join('、');
      return `<div class="profile-item" onclick="openReaderById('${c.id}')">
        <div class="profile-cover">
          <img src="${coverUrl}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=placeholder>📖</span>'">
        </div>
        <div class="profile-info">
          <div class="title">${escHtml(c.name)}</div>
          ${authorStr ? `<div class="author">${escHtml(authorStr)}</div>` : ''}
          <div class="meta">
            ${c.type === 'novel' ? `第${c.progress.page}章` : `${c.progress.page}/${c.progress.totalPages || '?'}页`} · ${pct}%
          </div>
          <div class="profile-progress-bar"><div class="fill" style="width:${pct}%"></div></div>
        </div>
        <span class="profile-arrow">→</span>
      </div>`;
    }).join('');
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>还没有观看记录</p><p class="hint">开始阅读漫画后会自动记录</p></div>';
  }

  // 退出登录
  html += `<div style="margin-top:32px;text-align:center"><button class="action-btn" onclick="logout()">退出登录</button></div>`;

  container.innerHTML = html;
  setTimeout(loadPdfCovers, 500);
}

// ── 工具 ──
function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ── 封面加载 ──
// 主路径：卡片模板里的 <img loading="lazy" src=封面URL> 已由浏览器原生懒加载
// （视口外不请求、同源并发约 6），配合服务端"扫描后后台预生成封面"，首屏基本秒出。
// 这里只处理 PDF 的兜底：服务端抠图失败（加密 PDF 等）时，再用前端 pdf.js 现渲。
let _coverObserver = null;

function loadPdfCovers() {
  if (!('IntersectionObserver' in window)) return;
  if (_coverObserver) _coverObserver.disconnect(); // 重复渲染（翻页/筛选）时避免 observer 泄漏
  _coverObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      _coverObserver.unobserve(e.target);
      const el = e.target;
      const card = el.closest('.comic-card');
      if (!card) continue;
      const id = card.getAttribute('onclick')?.match(/'(.*?)'/)?.[1];
      const comic = Object.values(allSeries).flatMap(s => s.flatMap(x => x.items)).find(c => c.id === id);
      if (!comic || comic.ext !== 'pdf') continue;
      // 服务端封面（pdfcover 抠首图）正常情况下已被原生 <img> 加载；
      // 仅当该 <img> 加载失败（404/加密）时，才退化为 pdf.js 下载整本渲染。
      const img = el.querySelector('img');
      const fallback = () => renderPdfCover(el, comic);
      if (img) {
        if (img.complete && img.naturalWidth === 0) fallback();
        else img.addEventListener('error', fallback, { once: true });
      }
    }
  }, { rootMargin: '200px' });
  document.querySelectorAll('.comic-cover').forEach(el => {
    const card = el.closest('.comic-card');
    if (!card) return;
    const id = card.getAttribute('onclick')?.match(/'(.*?)'/)?.[1];
    const comic = Object.values(allSeries).flatMap(s => s.flatMap(x => x.items)).find(c => c.id === id);
    if (comic && comic.ext === 'pdf') _coverObserver.observe(el);
  });
}

// 前端兜底：服务端（lib/pdfcover.js）已能抠图出封面，正常 <img> 即可显示。
// 旧逻辑会在封面加载失败时「整本下载 PDF → 解码 → 回传 NAS」，是移动端内存炸弹 + NAS 写 IO 过载
// （白屏崩溃 / 重载巨慢）的主因之一。改为：仅对彻底失败的封面显示轻量占位，绝不下整本 PDF、绝不回传写盘。
function renderPdfCover(coverEl, comic) {
  if (!coverEl) return;
  if (coverEl.querySelector('img')) return; // 已有封面则不覆盖
  coverEl.innerHTML = '<div class="placeholder-cover" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;color:#555">📖</div>';
}

function logout() {
  localStorage.removeItem('fn_comic_token');
  localStorage.removeItem('fn_comic_user');
  window.location.href = '/';
}

/* ===== Gemini 双轨制引擎注入（2026-08-12 安全修复版：追加覆盖 renderGrid/renderComicGridByTag，新增 toggleLayout/parseMangaMeta/renderSingleMangaCard） ===== */
// ==========================================
// 注入：双轨制引擎控制器与元数据解析 (安全修复版)
// ==========================================
let currentLayout = 'spatial';
const iconList = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
const iconGrid = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;

function toggleLayout() {
  currentLayout = (currentLayout === 'spatial') ? 'pragmatic' : 'spatial';
  document.body.setAttribute('data-layout', currentLayout);
  const btn = $('layoutToggleBtn');
  if (btn) btn.innerHTML = (currentLayout === 'spatial') ? iconList : iconGrid;
  
  // 兼容漫画 Tab 的标签云状态刷新
  if (currentTab === 'comic') {
    renderComicGridByTag(); 
  } else if (currentTab === 'novel') {
    renderGrid('novelGrid', 'continueNovel', allSeries.novel);
  } else if (currentTab === 'all') {
    renderGrid('allGrid', 'continueAll', allSeries.all);
  }
}

// 修复 P0-1：修正无限循环
function parseMangaMeta(rawTitle) {
  let title = rawTitle || '';
  const groupMatch = title.match(/^\[(.*?)\]/);
  const group = groupMatch ? groupMatch[1].trim() : '';
  title = title.replace(/^\[(.*?)\]\s*/, '');
  const authorMatch = title.match(/[（(](.*?)[）)]/);
  let author = '';
  if (authorMatch) { 
    author = authorMatch[1].trim(); 
    title = title.replace(authorMatch[0], ''); 
  }
  return { group, author, title: title.trim() || rawTitle };
}

// ==========================================
// 覆盖原有的 renderGrid 与 renderComicGridByTag
// ==========================================

function renderGrid(gridId, continueId, series) {
  const flat = series.flatMap(s => s.items);
  const grid = $(gridId);
  if (!grid) return;
  grid.classList.add('series-container');

  const contEl = $(continueId);
  if (contEl) {
    const withProgress = flat.filter(c => c.progress && c.progress.page > 0)
      .sort((a, b) => new Date(b.progress.updatedAt || 0) - new Date(a.progress.updatedAt || 0))
      .slice(0, 1);
      
    if (withProgress.length > 0) {
      const comic = withProgress[0];
      const meta = parseMangaMeta(comic.name);
      const authorStr = (comic.authors && comic.authors.length > 0) ? comic.authors.slice(0, 2).join('、') : meta.author;
      const coverUrl = ComicAPI.getCoverUrl(comic.id);
      
      // 修复 P0-2：使用 progress.totalPages
      const pct = (comic.progress && comic.progress.totalPages) 
        ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;
      
      const aura = $('ambientAura');
      // 修复 P1-4：安全设置 backgroundImage
      if (aura) aura.style.backgroundImage = `url("${coverUrl.replace(/"/g, '&quot;')}")`;

      if (currentLayout === 'spatial') {
        contEl.innerHTML = `<h2 class="section-title">继续阅读</h2>
          <div class="hero-spatial" onclick="openReaderById('${comic.id}')">
            <img src="${coverUrl}" class="hero-cover-art" loading="lazy">
            <div class="hero-overlay">
              <h1 class="hero-title">${escHtml(meta.title)}</h1>
              <p class="hero-sub">${authorStr ? `✎ ${escHtml(authorStr)} · ` : ''}读至 ${pct}%</p>
            </div>
          </div>`;
      } else {
        contEl.innerHTML = `<h2 class="section-title">继续阅读</h2>
          <div class="hero-pragmatic" onclick="openReaderById('${comic.id}')">
            <img src="${coverUrl}" class="hero-cover-art" loading="lazy">
            <div class="hero-info">
              <div class="hero-title">${escHtml(meta.title)}</div>
              <div class="hero-sub">${authorStr ? `✎ ${escHtml(authorStr)}` : ''}</div>
              <div>
                <div class="hero-sub" style="margin-bottom:6px; font-size:12px;">读至 ${pct}%</div>
                <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              </div>
            </div>
          </div>`;
      }
      contEl.style.display = 'block';
    } else {
      contEl.style.display = 'none';
      if ($('ambientAura')) $('ambientAura').style.backgroundImage = 'none';
    }
  }

  if (flat.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>书架空空如也</p></div>';
    return;
  }

  // ── 窗口化渲染：同一时刻只保留有限卡片在 DOM，滚动到哪渲染到哪 ──
  // iOS Safari 单标签页内存预算极低，一次性把整库 577 张卡片塞进 DOM，
  // 会在切换标签时叠加第二个整库网格 → WebContent 被系统杀掉（"网页将重新载入"）。
  // 窗口化后 DOM 卡片数恒定（≈GRID_BATCH），对 Library 大小完全免疫。
  if (grid._gridObserver) { try { grid._gridObserver.disconnect(); } catch (e) {} grid._gridObserver = null; }
  grid.classList.add('series-container');
  const ctx = gridId.replace('Grid', '').replace('continue', '');
  const _flat = [];
  const _bySid = {};
  series.forEach((s, si) => {
    const sid = ctx + '::' + s.name;
    _bySid[sid] = s;
    s.items.forEach((c, ii) => _flat.push({ si, ii, sid }));
  });
  grid._gstate = { series, flat: _flat, bySid: _bySid, pos: 0, openSid: null, openGridEl: null };
  grid.innerHTML = '';
  grid._sentinel = document.createElement('div');
  grid._sentinel.className = 'grid-sentinel';
  grid._sentinel.style.height = '1px';
  grid.appendChild(grid._sentinel);
  appendGridBatch(grid);
}

// 窗口化追加一批（GRID_BATCH 张）。跨系列连续渲染；系列被截断时，下一批从该系列
// 已有的 .series-grid 继续追加，不重复开节头。折叠的系列跳过渲染，展开时再按需填充。
function appendGridBatch(grid) {
  const GRID_BATCH = 60;
  const st = grid._gstate;
  if (!st) return;
  let n = 0;
  while (st.pos < st.flat.length && n < GRID_BATCH) {
    const f = st.flat[st.pos];
    const s = st.series[f.si];
    if (f.sid !== st.openSid) {
      st.openSid = f.sid;
      const section = document.createElement('div');
      section.className = 'series-section' + (collapsedSeries.has(f.sid) ? ' collapsed' : '');
      section.dataset.sid = f.sid;
      section.innerHTML =
        '<div class="series-section-header" onclick="toggleSeriesSection(this)">' +
          '<span class="series-title"><span class="series-name">' + escHtml(s.name) + '</span><span class="count">' + s.items.length + '</span></span>' +
          '<svg class="series-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
        '</div>' +
        '<div class="series-body"><div class="series-grid"></div></div>';
      grid.insertBefore(section, grid._sentinel);
      st.openGridEl = section.querySelector('.series-grid');
    }
    if (!collapsedSeries.has(f.sid)) {
      st.openGridEl.insertAdjacentHTML('beforeend', renderSingleMangaCard(s.items[f.ii], f.ii));
    }
    st.pos++; n++;
  }
  if (st.pos >= st.flat.length) {
    if (grid._sentinel && grid._sentinel.parentNode) grid._sentinel.remove();
    if (grid._gridObserver) { try { grid._gridObserver.disconnect(); } catch (e) {} grid._gridObserver = null; }
  } else if (grid._sentinel && !grid._gridObserver) {
    grid._gridObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) appendGridBatch(grid);
    }, { rootMargin: '600px' });
    grid._gridObserver.observe(grid._sentinel);
  }
  if (typeof loadPdfCovers === 'function') setTimeout(loadPdfCovers, 50);
}

// 抽离单卡片渲染函数，复用于 renderGrid 与 renderComicGridByTag，修复 P0-3 与 P1-3
function renderSingleMangaCard(comic, index = 0) {
  const meta = parseMangaMeta(comic.name);
  const authorStr = (comic.authors && comic.authors.length > 0) ? comic.authors.slice(0, 2).join('、') : meta.author;
  const coverUrl = ComicAPI.getCoverUrl(comic.id);
  
  return `
  <div class="manga-card" style="animation-delay:${index * 0.03}s" 
       onclick="openComicById('${comic.id}')"
       oncontextmenu="event.preventDefault();showComicMenu(event,'${comic.id}')">
    <div class="manga-cover-wrap">
      <img src="${coverUrl}" class="manga-cover" loading="lazy">
      ${comic.bookmarked ? '<div class="badge-bookmark">★</div>' : ''}
      ${comic.isTranslated ? '<div class="badge-translated">译</div>' : ''}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(meta.title)}</div>
      ${authorStr ? `<div class="author">✎ ${escHtml(authorStr)}</div>` : ''}
    </div>
  </div>`;
}

// 修复 P1-1：同步更新漫画页按标签筛选的网格渲染
function renderComicGridByTag() {
  // 同步排序切换条的选中态
  document.querySelectorAll('#page-comic .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === comicSortMode));
  let series;
  if (!selectedTag) {
    series = allSeries.comic;
  } else {
    series = (allSeries.comic || []).map(s => ({
      ...s,
      items: s.items.filter(c => (c.tags || []).includes(selectedTag))
    })).filter(s => s.items.length > 0);
  }
  // 按时间排序：打平为单序列，按 mtime 降序（最近添加/修改的排最前）
  if (comicSortMode === 'time') {
    const flat = series.flatMap(s => s.items)
      .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
    renderGrid('comicGrid', 'continueComic', [{ name: '按时间', count: flat.length, items: flat }]);
    return;
  }
  renderGrid('comicGrid', 'continueComic', series);
}

// ── 小说页标签云（可折叠，可筛选） ──
function renderNovelTagCloud() {
  const cloud = document.getElementById('filterChipsNovel');
  if (!cloud) return;
  const tagCount = {};
  for (const s of (allSeries.novel || [])) {
    for (const c of s.items) {
      for (const t of c.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    }
  }
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);
  const section = document.getElementById('tagSectionBodyNovel')?.closest('.tag-section');
  if (tags.length === 0) {
    cloud.style.display = 'none';
    if (section) section.style.display = 'none';
    return;
  }
  cloud.style.display = 'flex';
  if (section) {
    section.style.display = 'block';
    section.classList.toggle('collapsed', localStorage.getItem('tagCloud_section_collapsed_novel') === '1');
  }
  const countEl = document.getElementById('tagSectionCountNovel');
  if (countEl) countEl.textContent = tags.length;
  let html = `<button class="tag-pill ${selectedNovelTag ? '' : 'active'}" onclick="clearNovelTagFilter()">全部</button>`;
  tags.forEach(([t, n]) => {
    html += `<button class="tag-pill ${selectedNovelTag === t ? 'active' : ''}" onclick="toggleNovelTagFilter('${escHtml(t).replace(/'/g, "\\'")}')">${escHtml(t)}<span class="count">${n}</span></button>`;
  });
  cloud.innerHTML = html;
}
function toggleNovelTagFilter(tag) {
  selectedNovelTag = (selectedNovelTag === tag) ? null : tag;
  renderNovelTagCloud();
  renderNovelGridByTag();
}
function clearNovelTagFilter() {
  selectedNovelTag = null;
  renderNovelTagCloud();
  renderNovelGridByTag();
}
function renderNovelGridByTag() {
  // 同步排序切换条的选中态
  document.querySelectorAll('#page-novel .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === novelSortMode));
  let series;
  if (!selectedNovelTag) {
    series = allSeries.novel;
  } else {
    series = (allSeries.novel || []).map(s => ({
      ...s,
      items: s.items.filter(c => (c.tags || []).includes(selectedNovelTag))
    })).filter(s => s.items.length > 0);
  }
  // 按时间排序：打平为单序列，按 mtime 降序（最近添加/修改的排最前）
  if (novelSortMode === 'time') {
    const flat = series.flatMap(s => s.items)
      .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
    renderGrid('novelGrid', 'continueNovel', [{ name: '按时间', count: flat.length, items: flat }]);
    return;
  }
  renderGrid('novelGrid', 'continueNovel', series);
}

// ── 在线模块（禁漫天堂：搜索 / 详情 / 在线阅读） ──
let currentOnlinePage = 1;
let currentOnlineKeyword = '';
let currentOnlineMaxPage = 1;
let currentOnlineOrder = 'mr';

// jm 图片走代理，统一加 token
function onlineImgUrl(rawUrl) {
  return `/api/online/img?url=${encodeURIComponent(rawUrl)}&token=${encodeURIComponent(getToken())}`;
}

function onOnlineSearchInput() {
  const v = document.getElementById('onlineSearchInput');
  const c = document.getElementById('onlineSearchClear');
  if (c) c.style.display = v && v.value ? 'block' : 'none';
}

function clearOnlineSearch() {
  const v = document.getElementById('onlineSearchInput');
  if (v) v.value = '';
  onOnlineSearchInput();
  currentOnlineKeyword = '';
  currentOnlinePage = 1;
  const results = document.getElementById('onlineResults');
  const empty = document.getElementById('onlineEmpty');
  const initial = document.getElementById('onlineInitial');
  if (results) results.style.display = 'none';
  if (empty) empty.style.display = 'none';
  if (initial) initial.style.display = 'block';
}

async function onlineSearch(page) {
  const v = document.getElementById('onlineSearchInput');
  const kw = (v ? v.value : '').trim();
  if (!kw) { toast('请输入搜索关键词'); return; }
  currentOnlineKeyword = kw;
  currentOnlinePage = page || 1;
  currentOnlineOrder = 'mr';

  const loading = document.getElementById('onlineLoading');
  const initial = document.getElementById('onlineInitial');
  const results = document.getElementById('onlineResults');
  const empty = document.getElementById('onlineEmpty');
  if (loading) loading.style.display = 'block';
  if (initial) initial.style.display = 'none';
  if (results) results.style.display = 'none';
  if (empty) empty.style.display = 'none';

  try {
    const res = await api(`/api/online/search?q=${encodeURIComponent(kw)}&order=${currentOnlineOrder}&page=${currentOnlinePage}`);
    const data = await res.json();
    if (!res.ok) { toast(data.error || '搜索失败'); if (loading) loading.style.display = 'none'; return; }
    currentOnlineMaxPage = data.maxPage || 1;
    const grid = document.getElementById('onlineGrid');
    if (grid) grid.innerHTML = (data.comics || []).map(renderOnlineCard).join('');
    if (loading) loading.style.display = 'none';
    if (data.comics && data.comics.length > 0) {
      if (results) results.style.display = 'block';
      const more = document.getElementById('onlineMore');
      if (more) more.style.display = currentOnlinePage < currentOnlineMaxPage ? 'block' : 'none';
    } else {
      if (empty) empty.style.display = 'block';
    }
  } catch (err) {
    if (loading) loading.style.display = 'none';
    if (err.message === '登录已过期') return;
    toast('在线搜索出错：' + (err.message || err));
  }
}

function renderOnlineCard(c) {
  const title = c.title || '';
  const author = c.author || '';
  const cover = c.cover ? onlineImgUrl(c.cover) : '';
  return `<div class="manga-card" onclick="onlineOpenAlbum('${escHtml(c.id)}')">
    <div class="manga-cover-wrap">
      ${cover ? `<img src="${cover}" class="manga-cover" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>📖</div>'">`
        : `<div class="placeholder-cover">${escHtml(title.slice(0, 2))}</div>`}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(title)}</div>
      ${author ? `<div class="author">✎ ${escHtml(author)}</div>` : ''}
    </div>
  </div>`;
}

async function onlineOpenAlbum(id) {
  detailBackPage = 'online';
  const el = document.getElementById('detailContent');
  if (el) el.innerHTML = '<div class="profile-loading">加载中…</div>';
  switchPage('detail');
  try {
    const res = await api(`/api/online/album/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) { if (el) el.innerHTML = `<div class="empty-state"><p>${escHtml(data.error || '加载失败')}</p></div>`; return; }
    renderOnlineDetail(data);
  } catch (err) {
    if (err.message === '登录已过期') return;
    if (el) el.innerHTML = '<div class="empty-state"><p>详情加载失败</p></div>';
  }
}

function renderOnlineDetail(a) {
  const cover = a.cover ? onlineImgUrl(a.cover) : '';
  const tags = [].concat(a.tags && a.tags.author || [], a.tags && a.tags.tags || [], a.tags && a.tags.works || [], a.tags && a.tags.actors || []);
  const tagHtml = tags.map(t => `<span class="detail-tag">${escHtml(t)}</span>`).join('');
  const chapters = a.chapters || [];
  const chapterHtml = chapters.map(ch => `
    <div class="volume-item" onclick="onlineOpenChapter('${escHtml(ch.id)}','${escHtml(a.title).replace(/'/g, "\\'")}','${escHtml(ch.title).replace(/'/g, "\\'")}')">
      <div class="volume-info">
        <div class="volume-name">${escHtml(ch.title)}</div>
      </div>
    </div>`).join('');

  let html = `
    <div class="detail-hero">
      <div class="detail-cover">
        ${cover ? `<img src="${cover}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>📖</div>'">` : `<div class="placeholder-cover">📖</div>`}
      </div>
      <div class="detail-meta-col">
        <div class="detail-title">${escHtml(a.title)}</div>
        ${a.author ? `<div class="detail-sub">作者：${escHtml(a.author)}</div>` : ''}
        ${a.likes ? `<div class="detail-sub">❤ ${a.likes}</div>` : ''}
        ${a.updateDate ? `<div class="detail-sub">更新：${escHtml(a.updateDate)}</div>` : ''}
        ${tagHtml ? `<div class="detail-tags">${tagHtml}</div>` : ''}
        <button class="detail-start" onclick="onlineOpenChapter('${escHtml(chapters[0] ? chapters[0].id : a.id)}','${escHtml(a.title).replace(/'/g, "\\'")}','${escHtml(chapters[0] ? chapters[0].title : '第1話').replace(/'/g, "\\'")}')">开始阅读</button>
      </div>
    </div>`;
  if (a.description) {
    html += `<div class="detail-section-title">简介</div><div class="jm-detail-meta" style="padding:0 4px 12px;color:var(--muted,#aaa);line-height:1.7;font-size:13px;">${escHtml(a.description)}</div>`;
  }
  if (chapters.length > 0) {
    html += `<div class="detail-section-title">章节列表<span class="count">共 ${chapters.length} 章</span></div><div class="volume-list">${chapterHtml}</div>`;
  }
  const el = document.getElementById('detailContent');
  if (el) el.innerHTML = html;
  const titleEl = document.getElementById('detailTitle');
  if (titleEl) titleEl.textContent = (a.title || '').length > 16 ? a.title.slice(0, 16) + '…' : (a.title || '');
}

async function onlineOpenChapter(epId, title, chapterTitle) {
  try {
    const res = await api(`/api/online/chapter/${encodeURIComponent(epId)}`);
    const data = await res.json();
    if (!res.ok) { toast(data.error || '章节加载失败'); return; }
    const images = data.images || [];
    if (images.length === 0) { toast('该章节无图片'); return; }
    openReader({
      id: 'jm-' + epId,
      name: chapterTitle && chapterTitle !== '第1話' ? `${title} ${chapterTitle}` : title,
      ext: 'cbz',
      online: true,
      images,
      pageCount: images.length,
    });
  } catch (err) {
    if (err.message === '登录已过期') return;
    toast('章节加载出错：' + (err.message || err));
  }
}
