// Shelf front end: tabs, grids, detail view, comments, online sources and downloads.

let allSeries = { comic: [], novel: [], all: [] };
// allSeries' contract is "tab name -> array"; keep anything else out or flatMap throws.
let recentData = null;

function allSeriesArrays() {
  return Object.values(allSeries).filter(Array.isArray);
}
let allComics = [];
let currentDetailComic = null;
let currentTab = 'comic';
let detailBackPage = 'comic';
let detailBackTag = null;
let detailBackScroll = 0;
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
let canDeleteComic = false;

function $(id) { return document.getElementById(id); }

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

async function initApp() {
  const token = getToken();
  if (!token) { window.location.href = '/'; return; }
  initTheme();
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

async function loadAllData(force = false, targetTab) {
  showSkeleton('comicGrid', 6);
  showSkeleton('novelGrid', 6);
  showSkeleton('allGrid', 8);

  try {
    // Fetch the library once and split by type locally; three requests transfer it twice.
    const resAll = await ComicAPI.getLibrary(null, force);
    const seriesAll = resAll.series || [];
    allSeries.all = seriesAll;
    allSeries.comic = splitSeriesByType(seriesAll, 'comic');
    allSeries.novel = splitSeriesByType(seriesAll, 'novel');
    recentData = { items: resAll.recent || [], label: resAll.recentLabel || '' };
    renderPage(targetTab || 'comic');
  } catch (err) {
    if (err.message === '登录已过期') return;
  }
}

function splitSeriesByType(seriesList, type) {
  const out = [];
  for (const s of seriesList) {
    const items = (s.items || []).filter(c => (c.type || 'comic') === type);
    if (items.length) out.push({ name: s.name, count: items.length, items });
  }
  return out;
}

// Several full-library grids alive at once gets the page killed on iOS.
const _HEAVY_TABS = new Set(['comic', 'novel', 'all']);
let _lastRenderedHeavy = null;

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
  if (_HEAVY_TABS.has(tab) && _lastRenderedHeavy === tab && !window._libraryNeedsRefresh) return;
  await renderPage(tab);
  _lastRenderedHeavy = tab;
}

function switchPage(tab) {
  switchTab(tab);
  // A detail page must start at the top, otherwise the cover animation lands off screen.
  if (tab === 'detail') window.scrollTo(0, 0);
  try {
    if (tab === 'detail' && currentDetailComic) {
      const jm = String(currentDetailComic.sourceId || currentDetailComic.id);
      const want = '#detail/' + encodeURIComponent(jm);
      if (location.hash !== want) history.pushState(null, '', want);
    } else {
      if (location.hash !== '#' + tab) history.pushState(null, '', '#' + tab);
    }
  } catch (e) {}
}

async function renderPage(tab) {
  if (window._libraryNeedsRefresh) {
    window._libraryNeedsRefresh = false;
    await loadAllData(false, tab);
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById('page-' + tab);
  if (pageEl) pageEl.classList.add('active');

  if (_HEAVY_TABS.has(tab)) {
    const gridFor = { comic: 'comicGrid', novel: 'novelGrid', all: 'allGrid' }[tab];
    ['comicGrid', 'novelGrid', 'allGrid'].forEach(id => { if (id !== gridFor) _clearGrid(id); });
  }

  if (tab === 'comic') { renderTagCloud(); renderComicGridByTag(); renderRecommend(); }
  else if (tab === 'novel') { renderNovelTagCloud(); renderNovelGridByTag(); }
  else if (tab === 'all') {
    buildFilterBar(allSeries.all.flatMap(s => s.items));
    renderAllGrid();
    if (recentData) {
      if (recentData.items.length > 0) {
        showRecentSection(recentData.items, recentData.label);
      }
    } else {
      try {
        const res = await ComicAPI.getLibrary();
        if (res.recent && res.recent.length > 0) showRecentSection(res.recent, res.recentLabel);
      } catch {}
    }
  }
  else if (tab === 'search') { renderRecentSearches(); }
  else if (tab === 'ranking') { await loadRanking('weekly'); }
  else if (tab === 'profile') { await renderProfile(); }
  else if (tab === 'online') { checkOnlineStatus(); }
}

let onlineEnabled = true;

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
    populateOnlineSources();
  } catch {  }
}

function renderGrid(gridId, continueId, series) {
  const flat = series.flatMap(s => s.items);
  const grid = $(gridId);
  if (!grid) return;

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
  // Release the previous grid's blob covers; leaked blobs are a common iOS OOM cause.
  grid.querySelectorAll('img').forEach(im => { if (im.src && im.src.indexOf('blob:') === 0) { try { URL.revokeObjectURL(im.src); } catch (e) {} } });
  grid.innerHTML = html;
  setTimeout(loadPdfCovers, 500);
}

function renderContinueCard(comic) {
  const pct = comic.progress && comic.progress.totalPages > 0
    ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;
  const authorStr = (comic.authors || []).slice(0, 2).join('、');
  const coverUrl = ComicAPI.getCoverUrl(comic.id);
  const typeLabel = comic.type === 'novel' ? '第' + comic.progress.page + '章' : comic.progress.page + '/' + (comic.progress.totalPages || '?') + '页';

  return `<h2 class="section-title">继续阅读</h2>
    <div class="continue-card" onclick="openReaderById('${comic.id}')">
      <div class="continue-cover">
        <img src="${coverUrl}" alt="" loading="lazy" decoding="async" 
          onerror="this.parentElement.innerHTML='<span class=placeholder>' + ico('book') + '</span>'"
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

function renderComicCard(comic, delay = 0) {
  const authorStr = (comic.authors || []).slice(0, 2).join('、');
  const coverUrl = ComicAPI.getCoverUrl(comic.id);
  const progressPct = comic.progress && comic.progress.totalPages > 0
    ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;

  const meta = parseMangaMeta(comic.name);
  const title = meta.title || comic.name;
  const titleAuthor = (comic.authors && comic.authors.length > 0) ? comic.authors.slice(0,2).join('、') : meta.author;
  return `<div class="manga-card" style="animation-delay:${delay}s"
    onclick="openComicById('${comic.id}')"
    oncontextmenu="event.preventDefault();showComicMenu(event,'${comic.id}')">
    <div class="manga-cover-wrap">
      ${coverUrl ? `<img src="${coverUrl}" class="manga-cover" alt="" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>' + ico('book') + '</div>'">`
        : `<div class="placeholder-cover">${escHtml(comic.name.slice(0, 2))}</div>`}
      ${progressPct > 0 ? `<div class="progress-indicator"><div class="fill" style="width:${progressPct}%"></div></div>` : ''}
      ${comic.bookmarked ? '<div class="badge-bookmark">' + ico('star', 'fill') + '</div>' : ''}
      ${comic.isTranslated ? '<div class="badge-translated">译</div>' : ''}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(title)}</div>
      ${titleAuthor ? `<div class="author">${ico('pen')} ${escHtml(titleAuthor)}</div>` : ''}
    </div>
  </div>`;
}

function showComicMenu(event, comicId) {
  event.preventDefault();
  const comic = allComics.flatMap(s => s.items).find(c => c.id === comicId);
  if (!comic) return;

  const shelves = userShelves.filter(s => !s.items.includes(comicId));
  let shelfOpts = shelves.map(s => `<div onclick="addToShelf('${s.id}','${comicId}')">+ ${escHtml(s.name)}</div>`).join('');

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-menu-content">
      <div class="menu-title">${escHtml(comic.name.slice(0, 20))}</div>
      <div onclick="toggleBookmarkComic('${comicId}')">${comic.bookmarked ? ico('star', 'fill') + ' 取消收藏' : ico('star-o') + ' 加入收藏'}</div>
      <div onclick="openReaderById('${comicId}')">${ico('book')} 开始阅读</div>
      ${shelfOpts ? '<hr>' + shelfOpts : ''}
      <div onclick="showCreateShelf('${comicId}')">+ 新建书架并加入</div>
      ${canDeleteComic ? '<hr><div style="color:#ff453a;font-weight:500" onclick="deleteComic(\'' + comicId + '\')">' + ico('trash') + ' 删除漫画（不可恢复）</div>' : ''}
      <hr><div onclick="this.parentElement.parentElement.remove()">取消</div>
    </div>
  `;
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  document.body.appendChild(menu);
  setTimeout(() => menu.classList.add('show'), 10);
  document.addEventListener('click', () => menu.remove(), { once: true });
}

async function deleteComic(id) {
  const comic = (allComics.length ? allComics : allSeriesArrays())
    .flatMap(s => (s.items || []))
    .find(c => c.id === id);
  const name = comic ? comic.name : id;
  if (!confirm('确定删除《' + name + '》？\n\n将永久删除：漫画文件本体 + 封面 + 全部元数据（进度/收藏/浏览/点赞/评论/书架），不可恢复！')) return;
  try {
    const r = await api('/api/comic/' + encodeURIComponent(id), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      toast('已删除：' + name);
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

function toggleFilterPanel() {
  const panel = document.getElementById('filterPanel');
  if (!panel) return;
  panel.classList.toggle('open');
}

function buildFilterBar(comics) {
  const tagCount = {};
  for (const c of comics) {
    for (const t of c.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  allTags = [
    ...Object.entries(tagCount).map(([n, c]) => ({ name: n, count: c, type: 'tag' })),
  ].sort((a, b) => b.count - a.count);

  const chips = document.getElementById('filterChipsAll');
  if (!chips || allTags.length === 0) return;
  const section = document.getElementById('tagSectionBodyAll')?.closest('.tag-section');
  if (section) section.classList.toggle('collapsed', localStorage.getItem('tagCloud_section_collapsed_all') === '1');
  const countEl = document.getElementById('tagSectionCountAll');
  if (countEl) countEl.textContent = allTags.length;
  let html = '<button class="filter-chip active" onclick="clearFilters()">全部</button>';
  allTags.forEach((t) => {
    html += `<button class="filter-chip" data-tag="${escHtml(t.name)}" onclick="toggleFilter('${escHtml(t.name).replace(/'/g, "\\'")}')">${t.type === 'author' ? ico('pen') + ' ' : ''}${escHtml(t.name)}<span class="count">${t.count}</span></button>`;
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
      const items = [...(c.tags || [])];
      return Array.from(activeFilters).every(f => items.includes(f));
    });
  }
  if (allSortMode === 'time') {
    filtered = filtered.sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
    renderGrid('allGrid', 'continueAll', [{ name: '', count: filtered.length, items: filtered }]);
    return;
  }
  // 平铺模式：不按 series 分组，按时间倒序显示所有漫画
  filtered = filtered.sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
  renderGrid('allGrid', 'continueAll', [{ name: '', count: filtered.length, items: filtered }]);
}

// 最近添加
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

// 排行榜
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
      <div class="rank-cover"><img src="${ComicAPI.getCoverUrl(item.id)}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 48 48%22><rect fill=%22%23333%22 width=%2248%22 height=%2248%22/><path fill=%22none%22 stroke=%22%23888%22 stroke-width=%221.8%22 stroke-linejoin=%22round%22 d=%22M24 19c-2-1.5-4-2-6-2h-2v14h2c2 0 4 .5 6 2 2-1.5 4-2 6-2h2V17h-2c-2 0-4 .5-6 2zM24 19v14%22/></svg>'"></div>
      <div class="rank-info">
        <div class="rank-title">${escHtml(item.name.slice(0, 35))}</div>
        <div class="rank-meta">${ico('heart', 'fill')} ${item.likes || 0} · ${ico('eye')} ${item.views || 0}</div>
      </div>
    </div>`).join('');
}

// 爱心（在阅读器调用）
async function toggleLikeFromReader(comicId) {
  try {
    await fetch(`/api/comic/${comicId}/like`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } });
  } catch {}
}

// 搜索
let searchTimer = null;
let recentSearches = JSON.parse(localStorage.getItem('fn_recent_searches') || '[]');

function renderRecentSearches() {
  const el = document.getElementById('recentSearches');
  if (!el) return;
  el.innerHTML = recentSearches.length > 0
    ? recentSearches.slice(0, 10).map(q => `<span class="recent-search-item" onclick="performSearch('${escHtml(q).replace(/'/g, "\\'")}')">${escHtml(q)}</span>`).join('')
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

// 自定义书架
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
      <div class="shelf-previews">${(s.previews || []).map(p => `<div class="shelf-preview-cover">${p.hasCover ? `<img src="${ComicAPI.getCoverUrl(p.id)}" alt="">` : ico('book')}</div>`).join('')}</div>
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

// 收藏切换
async function toggleBookmarkComic(id) {
  await ComicAPI.toggleBookmark(id);
  await loadAllData();
}

// 打开漫画
// 点开漫画 → 进入详情/系列枢纽页（而非直接进阅读器），
// 形成「书架 → 详情 → 阅读器」的自然返回栈。
// FLIP 共享元素状态
let flipSourceCard = null;

function openComicById(id, triggerEl) {
  const flat = allSeriesArrays().flatMap(s => s.flatMap(x => x.items));
  const comic = flat.find(c => c.id === id);
  if (!comic) return;

  // 1. 获取源卡片与初始尺寸
  let srcCard = triggerEl ? triggerEl.closest('.manga-card') : null;
  if (!srcCard) {
    srcCard = document.querySelector(`.manga-card[onclick*="'${id}'"]`);
  }
  flipSourceCard = srcCard;

  let firstRect = null;
  if (srcCard) {
    const imgEl = srcCard.querySelector('.manga-cover') || srcCard;
    firstRect = imgEl.getBoundingClientRect();
  }

  // 2. 记录浏览与返回位置
  fetch(`/api/comic/${id}/view`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } }).catch(() => {});
  detailBackPage = currentTab || 'comic';
  detailBackTag = selectedTag;
  detailBackScroll = window.scrollY || document.documentElement.scrollTop || 0;
  currentDetailComic = comic;

  // 3. 挂载详情页
  renderDetail(comic);
  switchPage('detail');

  // 4. 执行 FLIP 展开飞入
  if (firstRect && firstRect.width > 0) {
    requestAnimationFrame(() => {
      const destCover = document.querySelector('#page-detail .detail-cover');
      if (!destCover) return;
      const lastRect = destCover.getBoundingClientRect();
      runFlipAnimation(firstRect, lastRect, ComicAPI.getCoverUrl(comic.id), destCover);
    });
  }
}

function runFlipAnimation(firstRect, lastRect, coverUrl, destElement) {
  destElement.style.opacity = '0';

  const ghost = document.createElement('div');
  ghost.className = 'flip-ghost-proxy';
  ghost.style.backgroundImage = `url("${coverUrl}")`;
  ghost.style.top = `${firstRect.top}px`;
  ghost.style.left = `${firstRect.left}px`;
  ghost.style.width = `${firstRect.width}px`;
  ghost.style.height = `${firstRect.height}px`;
  ghost.style.borderRadius = '12px';
  document.body.appendChild(ghost);

  // 强制同步重排，确保初始状态落盘
  ghost.getBoundingClientRect();

  ghost.style.transform = `translate3d(${lastRect.left - firstRect.left}px, ${lastRect.top - firstRect.top}px, 0)`;
  ghost.style.width = `${lastRect.width}px`;
  ghost.style.height = `${lastRect.height}px`;
  ghost.style.borderRadius = '16px';

  const onEnd = () => {
    destElement.style.opacity = '';
    ghost.remove();
    ghost.removeEventListener('transitionend', onEnd);
  };
  ghost.addEventListener('transitionend', onEnd);
}

function showDetailBack() {
  const destCard = flipSourceCard;
  const currentDetailCover = document.querySelector('#page-detail .detail-cover');

  if (!destCard || !currentDetailCover || !currentDetailComic) {
    executeNormalBack();
    return;
  }

  const firstRect = currentDetailCover.getBoundingClientRect();
  const coverUrl = ComicAPI.getCoverUrl(currentDetailComic.id);

  executeNormalBack(() => {
    requestAnimationFrame(() => {
      const lastRect = destCard.getBoundingClientRect();
      // 容错：若返回时目标卡片在视口外，直接静默退出
      if (lastRect.bottom < 0 || lastRect.top > window.innerHeight) {
        flipSourceCard = null;
        return;
      }

      destCard.style.opacity = '0';
      const ghost = document.createElement('div');
      ghost.className = 'flip-ghost-proxy';
      ghost.style.backgroundImage = `url("${coverUrl}")`;
      ghost.style.top = `${firstRect.top}px`;
      ghost.style.left = `${firstRect.left}px`;
      ghost.style.width = `${firstRect.width}px`;
      ghost.style.height = `${firstRect.height}px`;
      ghost.style.borderRadius = '16px';
      document.body.appendChild(ghost);

      ghost.getBoundingClientRect();

      ghost.style.transform = `translate3d(${lastRect.left - firstRect.left}px, ${lastRect.top - firstRect.top}px, 0)`;
      ghost.style.width = `${lastRect.width}px`;
      ghost.style.height = `${lastRect.height}px`;
      ghost.style.borderRadius = '12px';

      ghost.addEventListener('transitionend', () => {
        destCard.style.opacity = '';
        ghost.remove();
        flipSourceCard = null;
      }, { once: true });
    });
  });
}

function executeNormalBack(callback) {
  if (detailBackPage === 'comic' && detailBackTag != null) {
    selectedTag = detailBackTag;
  }
  switchPage(detailBackPage || 'comic');
  const sc = detailBackScroll;
  if (sc > 0) {
    setTimeout(() => {
      window.scrollTo(0, sc);
      const grid = document.getElementById('comicGrid');
      if (grid && grid.scrollTop !== undefined) grid.scrollTop = sc;
      if (callback) callback();
    }, 50);
  } else {
    if (callback) callback();
  }
  detailBackScroll = 0;
}

// 从详情页 / 继续阅读 直达阅读器
function openReaderById(id) {
  const flat = allSeriesArrays().flatMap(s => s.flatMap(x => x.items));
  let comic = flat.find(c => String(c.sourceId) === String(id));
  if (!comic) comic = flat.find(c => String(c.id) === String(id));
  if (!comic) return;
  // 记录返回位置（从哪个 tab / 标签视图 / 滚动位置点开的），退出后能回到原位
  if (currentTab !== 'detail') {
    detailBackPage = currentTab || 'comic';
    detailBackTag = selectedTag;
    detailBackScroll = window.scrollY || document.documentElement.scrollTop || 0;
  }
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
    <button class="detail-back" onclick="showDetailBack()" aria-label="返回">${ico('arrow-left')}</button>
    <div class="detail-hero">
      <div class="detail-cover">
        <img src="${coverUrl}" alt="" loading="lazy" decoding="async"
          onerror="this.parentElement.innerHTML='<div class=placeholder-cover>' + ico('book') + '</div>'">
      </div>
      <div class="detail-meta-col">
        <div class="detail-title">${escHtml(comic.name)}</div>
        ${series && series.name !== comic.name ? `<div class="detail-sub">系列：${escHtml(series.name)}</div>` : ''}
        ${ext ? `<div class="detail-sub">格式：${ext}</div>` : ''}
        ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
        <button class="detail-start" onclick="openReaderById('${comic.id}')">${startLabel}</button>
        ${canDeleteComic ? `<button class="detail-start" style="background:rgba(255,69,58,0.12);color:#ff453a;margin-top:10px" onclick="deleteComic('${comic.id}')">${ico('trash')} 删除漫画（不可恢复）</button>` : ''}
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
            <img src="${ComicAPI.getCoverUrl(vol.id)}" alt="" loading="lazy" decoding="async"
              onerror="this.parentElement.innerHTML='<div class=placeholder-cover>' + ico('book') + '</div>'">
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
  const flat = allSeriesArrays().flatMap(s => s.flatMap(x => x.items));
  let comic = flat.find(c => String(c.sourceId) === String(id));
  if (!comic) comic = flat.find(c => String(c.id) === String(id));
  if (!comic) {
    // 数据未就绪时回退到点开前的页面（不默认回漫画主界面）
    switchPage(detailBackPage || 'comic');
    return;
  }
  currentDetailComic = comic;
  renderDetail(comic);
  switchPage('detail');
}

// 详情页返回到来源书架页
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

// 标签云（漫画页顶部快速筛选，可折叠区块头）
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
function toggleSeriesSection(headerEl) {
  const section = headerEl.closest('.series-section');
  if (!section) return;
  const sid = section.dataset.sid;
  if (collapsedSeries.has(sid)) {
    collapsedSeries.delete(sid);
    section.classList.remove('collapsed');
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
function scrollRow(btn, dir) {
  const row = btn.parentElement.querySelector('.rec-scroll');
  if (!row) return;
  row.scrollBy({ left: dir * Math.max(240, Math.round(row.clientWidth * 0.8)), behavior: 'smooth' });
}
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

function setComicSort(mode) {
  comicSortMode = mode;
  try { localStorage.setItem('comic_sort', mode); } catch (e) {}
  renderComicGridByTag();
}
function setNovelSort(mode) {
  novelSortMode = mode;
  try { localStorage.setItem('novel_sort', mode); } catch (e) {}
  renderNovelGridByTag();
}
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
  document.querySelectorAll('#page-comic .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === comicSortMode));
  let comics;
  if (!selectedTag) {
    comics = (allSeries.comic || []).flatMap(s => s.items);
  } else {
    comics = (allSeries.comic || []).flatMap(s => s.items).filter(c => (c.tags || []).includes(selectedTag));
  }
  if (comics.length === 0) {
    renderGrid('comicGrid', 'continueComic', [{ name: '', count: 0, items: [] }]);
    return;
  }
  const tagGroups = {};
  for (const c of comics) {
    const seen = new Set();
    for (const t of (c.tags || [])) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!tagGroups[t]) tagGroups[t] = [];
      tagGroups[t].push(c);
    }
  }
  const MAX_PER_TAG = 60;
  const MIN_COUNT = 2;
  let series;
  if (selectedTag) {
    series = [{
      name: selectedTag,
      tag: selectedTag,
      count: comics.length,
      total: comics.length,
      items: comics.slice().sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
    }];
  } else {
    series = Object.entries(tagGroups)
      .filter(([t, items]) => items.length >= MIN_COUNT)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, items]) => ({
        name: t,
        tag: t,
        count: items.length,
        total: items.length,
        items: items
          .slice()
          .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
          .slice(0, MAX_PER_TAG)
      }));
    // Books with no tags fall into no group at all, so collect them as "uncategorised".
    const taggedIds = new Set();
    for (const arr of Object.values(tagGroups)) for (const c of arr) taggedIds.add(c.id);
    const untagged = comics.filter(c => !taggedIds.has(c.id));
    if (untagged.length > 0) {
      series.push({
        name: '未分类',
        tag: '',
        count: untagged.length,
        total: untagged.length,
        items: untagged
          .slice()
          .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
          .slice(0, MAX_PER_TAG)
      });
    }
    if (series.length === 0) {
      series = [{ name: '', count: comics.length, total: comics.length, items: comics.slice(0, MAX_PER_TAG) }];
    }
  }
  renderGrid('comicGrid', 'continueComic', series);
}

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
  attachHorizontalScrollPhysics();
}

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
const JM_MODES = {
  id:   { cmd: 'jm',       label: '按 ID（/jm）',         hint: '本子 ID，如 123456',             ingest: true  },
  kw:   { cmd: 'jms',      label: '按关键词（/jms）',      hint: '关键词，支持 tag:全彩 / author:xxx / 第2页', ingest: true },
  upd:  { cmd: 'jmupdate', label: '增量更新（/jmupdate）', hint: '本子 ID，只下新增章节',           ingest: true  },
  info: { cmd: 'jmi',      label: '详情（/jmi）',          hint: '本子 ID，查看详情（不入库）',      ingest: false },
};
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
      if (r) { r.className = 'jm-result err'; r.innerHTML = ico('alert') + ' ' + escHtml(String(res.message || '发送失败')) + '（可改用“复制指令”手动发送）'; }
      toast(res.message || '发送失败');
      return;
    }
    if (!res.sessionId) {
      if (r) { r.className = 'jm-result ok'; r.innerHTML = ico('check-circle') + ' 已发送：<b>' + escHtml(res.command) + '</b>' + (res.reply ? '<br>Bot：' + escHtml(res.reply).replace(/\n/g, '<br>') : ''); }
      return;
    }
    jmPollSid = res.sessionId;
    jmLastSnap = ''; jmStableCount = 0; jmPollCount = 0;
    await pollJmSession(ingest);
    jmPollTimer = setInterval(() => pollJmSession(ingest), 1500);
  } catch (e) {
    if (r) { r.style.display = 'block'; r.className = 'jm-result err'; r.innerHTML = ico('alert') + ' 网络错误：' + escHtml(String(e)); }
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
  const allText = data.filter(m => m.role === 'bot' && m.type === 'text').map(m => m.text || '').join('\n');
  const done = /(完成|入库|已下载|下载成功|成功收编|已入库|已加入)/.test(allText);
  const snap = JSON.stringify(data);
  if (snap === jmLastSnap) jmStableCount++; else jmStableCount = 0;
  jmLastSnap = snap;
  jmPollCount++;
  const stableStop = !ingest && jmStableCount >= 3;
  const timeoutStop = jmPollCount >= 80;
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
    html += '<div class="jm-progress-label">' + (done ? ico('check-circle') + ' 完成' + (ingest ? '，刷新书架即可看到' : '') : (pct > 0 ? ('下载中 ' + pct + '%') : '任务已提交，等待 Bot 响应…')) + '</div>';
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

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('fnToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

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

const PROFILE_TIMEOUT_MS = 15000;

function renderProfileTimeout(el) {
  el.innerHTML = '<div class="empty-state"><p>加载超时</p>' +
    '<p class="hint">漫画盘可能暂时性 I/O 繁忙（磁盘偶发错误），点下方按钮重试</p>' +
    '<button class="action-btn" onclick="renderProfile()">重试</button></div>';
}

async function renderProfile() {
  const el = $('profileContent');
  if (!el) return;

  el.innerHTML = '<div class="profile-loading">加载中...</div>';

  const timer = setTimeout(() => renderProfileTimeout(el), PROFILE_TIMEOUT_MS);
  try {
    const [bookmarks, recent, downloads] = await Promise.all([
      ComicAPI.getBookmarks(),
      ComicAPI.getContinue(),
      ComicAPI.getDownloads(20).catch(() => ({ items: [] }))
    ]);
    clearTimeout(timer);
    renderProfileContent(el, bookmarks, recent, downloads);
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

function renderProfileContent(container, bookmarks, recent, downloads) {
  let html = '';

  html += '<h2 class="section-title">收藏 <span class="count">' + bookmarks.length + ' 本</span></h2>';
  if (bookmarks.length > 0) {
    html += '<div class="library-grid profile-grid">';
    html += bookmarks.map((c, i) => renderComicCard({ ...c, progress: c.progress || null, bookmarked: true }, i * 0.03)).join('');
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>还没有收藏</p><p class="hint">阅读时长按漫画或点 ' + ico('star', 'fill') + ' 即可收藏</p></div>';
  }

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
          <img src="${coverUrl}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<span class=placeholder>' + ico('book') + '</span>'">
        </div>
        <div class="profile-info">
          <div class="title">${escHtml(c.name)}</div>
          ${authorStr ? `<div class="author">${escHtml(authorStr)}</div>` : ''}
          <div class="meta">
            ${c.type === 'novel' ? `第${c.progress.page}章` : `${c.progress.page}/${c.progress.totalPages || '?'}页`} · ${pct}%
          </div>
          <div class="profile-progress-bar"><div class="fill" style="width:${pct}%"></div></div>
        </div>
        <span class="profile-arrow">${ico('chevron-right')}</span>
      </div>`;
    }).join('');
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>还没有观看记录</p><p class="hint">开始阅读漫画后会自动记录</p></div>';
  }

  const dlItems = (downloads && downloads.items) || [];
  html += '<h2 class="section-title" style="margin-top:24px">最近下载 <span class="count">' + dlItems.length + ' 条</span></h2>';
  if (dlItems.length > 0) {
    html += '<div class="download-list">';
    html += dlItems.map(d => {
      const ok = d.status === 'done';
      const files = (d.files || []).join('、');
      return `<div class="download-item">
        <div class="dl-dot${ok ? '' : ' fail'}"></div>
        <div class="dl-body">
          <div class="dl-title">${escHtml(d.title || '未命名')}<span class="dl-count">${d.epCount || 1} 话</span></div>
          <div class="dl-meta">${escHtml(fmtTimeCn(d.finishedAt))}${d.user ? ' · ' + escHtml(d.user) : ''}</div>
          ${files ? `<div class="dl-files">${escHtml(files)}</div>` : ''}
          ${d.error ? `<div class="dl-files dl-err">${escHtml(d.error)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    html += '</div>';
  } else {
    html += '<div class="empty-state"><p>还没有下载记录</p><p class="hint">在「在线」页找到漫画后，点 ' + ico('download') + ' 下载到库</p></div>';
  }

  html += `<div style="margin-top:32px;text-align:center"><button class="action-btn" onclick="logout()">退出登录</button></div>`;

  container.innerHTML = html;
  setTimeout(loadPdfCovers, 500);
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function fmtTimeCn(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const p = n => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return iso; }
}

const DLQ_KEY = 'fn_comic_dlqueue';
let dlQueue = [];
let onlineSelMode = false;
let onlineCache = {};
let _dlDoneResolve = null;

try { dlQueue = JSON.parse(localStorage.getItem(DLQ_KEY) || '[]'); } catch (e) { dlQueue = []; }
if (!Array.isArray(dlQueue)) dlQueue = [];

function queueKey(id, source) { return `${source || ''}:${id}`; }
function inQueue(id, source) { return dlQueue.some(x => x.key === queueKey(id, source)); }

function saveQueue() {
  try { localStorage.setItem(DLQ_KEY, JSON.stringify(dlQueue)); } catch (e) {}
  updateSelBar();
  const qm = document.getElementById('queueModal');
  if (qm && qm.style.display === 'flex') renderQueuePanel();
}

function markQueued(el, on) {
  if (!el) return;
  el.classList.toggle('sel-on', on);
  el.style.outline = on ? '2px solid #0A84FF' : '';
  el.style.borderRadius = on ? '14px' : '';
  const c = el.querySelector('.vol-check');
  if (c) c.style.display = on ? 'flex' : 'none';
}

function longPressQueue(id, source, el) {
  if (!onlineSelMode) { onlineSelMode = true; updateSelBar(); }
  toggleQueue(id, source, el);
}

function toggleQueue(id, source, el) {
  const key = queueKey(id, source);
  const i = dlQueue.findIndex(x => x.key === key);
  if (i >= 0) {
    dlQueue.splice(i, 1);
    markQueued(el, false);
    toast('已从清单移除');
  } else {
    const meta = onlineCache[key] || {};
    dlQueue.push({ key, id: String(id), title: meta.title || '', source: source || '', cover: meta.cover || '', addedAt: Date.now() });
    markQueued(el, true);
    toast('已加入下载清单');
  }
  saveQueue();
}

function removeFromQueue(key) {
  dlQueue = dlQueue.filter(x => x.key !== key);
  saveQueue();
  renderQueuePanel();
}

function clearQueue() {
  dlQueue = [];
  saveQueue();
  renderQueuePanel();
}

function exitSelMode() {
  onlineSelMode = false;
  document.querySelectorAll('.sel-on').forEach(el => markQueued(el, false));
  updateSelBar();
}

function updateSelBar() {
  const bar = document.getElementById('selBar');
  if (!bar) return;
  if (!onlineSelMode && !dlQueue.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  const n = document.getElementById('selCount');
  if (n) n.textContent = dlQueue.length;
}

function openQueuePanel() {
  const m = document.getElementById('queueModal');
  if (!m) return;
  renderQueuePanel();
  m.style.display = 'flex';
}

function closeQueuePanel() {
  const m = document.getElementById('queueModal');
  if (m) m.style.display = 'none';
}

function renderQueuePanel() {
  const el = document.getElementById('queueBody');
  if (!el) return;
  if (!dlQueue.length) {
    el.innerHTML = '<div class="log-empty">清单是空的<br><span style="font-size:11.5px;opacity:.7">在线页长按漫画卡片即可加入</span></div>';
    return;
  }
  el.innerHTML = dlQueue.map(x => `<div style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;margin-bottom:6px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06)">
    ${x.cover
      ? `<img src="${escHtml(x.cover)}" alt="" loading="lazy" style="flex:none;width:38px;height:50px;object-fit:cover;border-radius:6px" onerror="this.style.display='none'">`
      : `<div style="flex:none;width:38px;height:50px;border-radius:6px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:18px">${ico('book')}</div>`}
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;color:#fff;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(x.title || x.id)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:3px">${escHtml(x.source || '')} · ID ${escHtml(x.id)}</div>
    </div>
    <button onclick="removeFromQueue('${escHtml(x.key)}')" aria-label="移除"
      style="flex:none;width:28px;height:28px;border-radius:8px;border:none;background:rgba(255,69,58,0.14);color:#ff453a;font-size:13px;cursor:pointer">${ico('x')}</button>
  </div>`).join('');
}

async function downloadQueue() {
  if (!dlQueue.length) { toast('清单是空的'); return; }
  const items = dlQueue.slice();
  closeQueuePanel();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const album = await ComicAPI.getOnlineAlbum(it.id, it.source);
      const chapters = (album && album.chapters) || [];
      const episodes = chapters.length
        ? chapters.map(c => ({ id: String(c.id), title: c.title || '' }))
        : [{ id: it.id, title: '' }];
      toast(`(${i + 1}/${items.length}) 正在下载：${it.title || it.id}`);
      await runDownloadAndWait(it.title || it.id, episodes, album || {});
    } catch (e) {
    }
    removeFromQueue(it.key);
  }
  toast('清单下载完成');
}

function runDownloadAndWait(title, episodes, album) {
  return new Promise(resolve => {
    _dlDoneResolve = resolve;
    startOnlineDownload(title, episodes, album);
  });
}

function handleOnlineCardTap(id, source, el) {
  if (onlineSelMode) { toggleQueue(id, source, el); return; }
  onlineOpenAlbum(id, source);
}

let _coverObserver = null;

function loadPdfCovers() {
  if (!('IntersectionObserver' in window)) return;
  if (_coverObserver) _coverObserver.disconnect();
  _coverObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      _coverObserver.unobserve(e.target);
      const el = e.target;
      const card = el.closest('.comic-card');
      if (!card) continue;
      const id = card.getAttribute('onclick')?.match(/'(.*?)'/)?.[1];
      const comic = allSeriesArrays().flatMap(s => s.flatMap(x => x.items)).find(c => c.id === id);
      if (!comic || comic.ext !== 'pdf') continue;
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
    const comic = allSeriesArrays().flatMap(s => s.flatMap(x => x.items)).find(c => c.id === id);
    if (comic && comic.ext === 'pdf') _coverObserver.observe(el);
  });
}

function renderPdfCover(coverEl, comic) {
  if (!coverEl) return;
  if (coverEl.querySelector('img')) return;
  coverEl.innerHTML = '<div class="placeholder-cover" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:30px;color:#555">' + ico('book') + '</div>';
}

function logout() {
  localStorage.removeItem('fn_comic_token');
  localStorage.removeItem('fn_comic_user');
  window.location.href = '/';
}

let currentLayout = 'spatial';
const iconList = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;
const iconGrid = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;

function toggleLayout() {
  currentLayout = (currentLayout === 'spatial') ? 'pragmatic' : 'spatial';
  document.body.setAttribute('data-layout', currentLayout);
  const btn = $('layoutToggleBtn');
  if (btn) btn.innerHTML = (currentLayout === 'spatial') ? iconList : iconGrid;

  if (currentTab === 'comic') {
    renderComicGridByTag(); 
  } else if (currentTab === 'novel') {
    const nf = (allSeries.novel || []).flatMap(s => s.items).sort((a,b) => (new Date(b.mtime||0)-new Date(a.mtime||0)));
    renderGrid('novelGrid', 'continueNovel', [{ name: '', count: nf.length, items: nf }]);
  } else if (currentTab === 'all') {
    const af = (allSeries.all || []).flatMap(s => s.items).sort((a,b) => (new Date(b.mtime||0)-new Date(a.mtime||0)));
    renderGrid('allGrid', 'continueAll', [{ name: '', count: af.length, items: af }]);
  }
}

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

      const pct = (comic.progress && comic.progress.totalPages) 
        ? Math.round((comic.progress.page / comic.progress.totalPages) * 100) : 0;

      const aura = $('ambientAura');
      if (aura) aura.style.backgroundImage = `url("${coverUrl.replace(/"/g, '&quot;')}")`;

      if (currentLayout === 'spatial') {
        contEl.innerHTML = `<h2 class="section-title">继续阅读</h2>
          <div class="hero-spatial" onclick="openReaderById('${comic.id}')">
            <img src="${coverUrl}" class="hero-cover-art" loading="lazy">
            <div class="hero-overlay">
              <h1 class="hero-title">${escHtml(meta.title)}</h1>
              <p class="hero-sub">${authorStr ? ico('pen') + ' ' + escHtml(authorStr) + ' · ' : ''}读至 ${pct}%</p>
            </div>
          </div>`;
      } else {
        contEl.innerHTML = `<h2 class="section-title">继续阅读</h2>
          <div class="hero-pragmatic" onclick="openReaderById('${comic.id}')">
            <img src="${coverUrl}" class="hero-cover-art" loading="lazy">
            <div class="hero-info">
              <div class="hero-title">${escHtml(meta.title)}</div>
              <div class="hero-sub">${authorStr ? ico('pen') + ' ' + escHtml(authorStr) : ''}</div>
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

  // 窗口化渲染：同一时刻只保留有限卡片在 DOM，滚动到哪渲染到哪
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
      if (s.name === '') {
        // flat：不显示系列名分组头，直接平铺卡片
        const flatBody = document.createElement('div');
        flatBody.className = 'series-body';
        flatBody.innerHTML = '<div class="series-grid"></div>';
        grid.insertBefore(flatBody, grid._sentinel);
        st.openGridEl = flatBody.querySelector('.series-grid');
      } else {
        const section = document.createElement('div');
        section.className = 'series-section' + (collapsedSeries.has(f.sid) ? ' collapsed' : '');
        section.dataset.sid = f.sid;
        var _count = (s.count != null) ? s.count : s.items.length;
        var _total = (s.total != null) ? s.total : _count;
        var _btn = '';
        if (selectedTag && s.tag === selectedTag) {
          _btn = '<span class="series-viewall" onclick="event.stopPropagation();clearTagFilter()">\u2190 \u8fd4\u56de\u5168\u90e8</span>';
        } else if (s.tag && _total > _count) {
          _btn = '<span class="series-viewall" onclick="event.stopPropagation();toggleTagFilter(\'' + s.tag.replace(/'/g, "\\'") + '\')">\u67e5\u770b\u5168\u90e8 ' + _total + ' \u672c \u203a</span>';
        }
        section.innerHTML =
          '<div class="series-section-header" onclick="toggleSeriesSection(this)">' +
            '<span class="series-title"><span class="series-name">' + escHtml(s.name) + '</span><span class="count">' + _count + '</span></span>' +
            _btn +
            '<svg class="series-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
          '</div>' +
          '<div class="series-body"><div class="series-grid"></div></div>';
        grid.insertBefore(section, grid._sentinel);
        st.openGridEl = section.querySelector('.series-grid');
      }
    }
    if (st.openGridEl && !collapsedSeries.has(f.sid)) {
      st.openGridEl.insertAdjacentHTML('beforeend', renderSingleMangaCard(s.items[f.ii], f.ii));
    }
    st.pos++; n++;
  }
  // iOS OOM 防护：仅分块模式（多 series-section）回收视口上方整块；flat 单组不删卡片
  try {
    if (st.series.length > 1) {
      const vh = window.innerHeight || 800;
      let removed = 0;
      for (let i = 0; i < grid.children.length && removed < 1; i++) {
        const node = grid.children[i];
        if (node === grid._sentinel || !node.classList) continue;
        if (node.classList.contains('series-section') && !node.contains(st.openGridEl)) {
          const r = node.getBoundingClientRect();
          if (r.bottom < -vh * 2) { node.remove(); removed++; }
        }
      }
    }
  } catch (e) {}
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
       onclick="openComicById('${comic.id}', this)"
       oncontextmenu="event.preventDefault();showComicMenu(event,'${comic.id}')">
    <div class="manga-cover-wrap">
      <img src="${coverUrl}" class="manga-cover" loading="lazy" decoding="async">
      ${comic.bookmarked ? '<div class="badge-bookmark">' + ico('star', 'fill') + '</div>' : ''}
      ${comic.isTranslated ? '<div class="badge-translated">译</div>' : ''}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(meta.title)}</div>
      ${authorStr ? `<div class="author">${ico('pen')} ${escHtml(authorStr)}</div>` : ''}
    </div>
  </div>`;
}

// 修复 P1-1：同步更新漫画页按标签筛选的网格渲染
function renderComicGridByTag() {
  // 同步排序切换条的选中态
  document.querySelectorAll('#page-comic .sort-chip').forEach(b => b.classList.toggle('active', b.dataset.sort === comicSortMode));
  let comics;
  if (!selectedTag) {
    comics = (allSeries.comic || []).flatMap(s => s.items);
  } else {
    comics = (allSeries.comic || []).flatMap(s => s.items).filter(c => (c.tags || []).includes(selectedTag));
  }
  if (comics.length === 0) {
    renderGrid('comicGrid', 'continueComic', [{ name: '', count: 0, items: [] }]);
    return;
  }
  // 按标签分组：每个标签一个区块，块内平铺该标签的本子
  const tagGroups = {};
  for (const c of comics) {
    const seen = new Set();
    for (const t of (c.tags || [])) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!tagGroups[t]) tagGroups[t] = [];
      tagGroups[t].push(c);
    }
  }
  const MAX_PER_TAG = 60; // 每块最多显示最新60本，避免超长列表卡顿
  const MIN_COUNT = 2;    // 过滤只有1本的冷门标签
  let series;
  if (selectedTag) {
    // 单标签全量视图：不截断，窗口化滚动加载全部
    series = [{
      name: selectedTag,
      tag: selectedTag,
      count: comics.length,
      total: comics.length,
      items: comics.slice().sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
    }];
  } else {
    series = Object.entries(tagGroups)
      .filter(([t, items]) => items.length >= MIN_COUNT)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, items]) => ({
        name: t,
        tag: t,
        count: items.length,
        total: items.length,
        items: items
          .slice()
          .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
          .slice(0, MAX_PER_TAG)
      }));
    /* 【2026-09-23 修复】把「没有任何标签」的书归入「未分类」组。
       原逻辑只对有标签的书分组，无标签的书（tags: []）进不了任何组，
       而 fallback（series.length===0 才显示全部）在本库永远不触发
       （库里有上千本带「中文」等标签的书），
       导致无标签的书在「漫画」tab 完全不可见 —— 只能去「全库」找。
       实测本库有 170+ 本属于这种情况。 */
    const taggedIds = new Set();
    for (const arr of Object.values(tagGroups)) for (const c of arr) taggedIds.add(c.id);
    const untagged = comics.filter(c => !taggedIds.has(c.id));
    if (untagged.length > 0) {
      series.push({
        name: '未分类',
        tag: '',
        count: untagged.length,
        total: untagged.length,
        items: untagged
          .slice()
          .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)))
          .slice(0, MAX_PER_TAG)
      });
    }
    if (series.length === 0) {
      series = [{ name: '', count: comics.length, total: comics.length, items: comics.slice(0, MAX_PER_TAG) }];
    }
  }
  renderGrid('comicGrid', 'continueComic', series);
}

// 小说页标签云（可折叠，可筛选）
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
  // 平铺模式：不按 series 分组，直接按时间倒序显示
  const flat = series.flatMap(s => s.items)
    .sort((a, b) => (new Date(b.mtime || 0) - new Date(a.mtime || 0)));
  renderGrid('novelGrid', 'continueNovel', [{ name: '', count: flat.length, items: flat }]);
}

// 在线模块（禁漫天堂：搜索 / 详情 / 在线阅读）
let currentOnlinePage = 1;
let currentOnlineKeyword = '';
let currentOnlineMaxPage = 1;
let currentOnlineOrder = 'mr';
let currentOnlineSource = ''; // 当前选中的在线源 key（用于 album/chapter/img 路由）

function populateOnlineSources() {
  const sel = document.getElementById('onlineSourceSelect');
  if (!sel) return;
  // 从 /api/online/sources 拉取已启用源列表
  api('/api/online/sources').then(async res => {
    const data = await res.json().catch(() => ({ sources: [] }));
    const list = (data.sources || []);
    sel.innerHTML = list.map(s => `<option value="${escHtml(s.key)}">${escHtml(s.name)}</option>`).join('');
    if (list.length > 1) {
      sel.style.display = 'inline-block';
      if (!currentOnlineSource || !list.find(s => s.key === currentOnlineSource)) {
        currentOnlineSource = list[0].key;
      }
      sel.value = currentOnlineSource;
    } else {
      sel.style.display = 'none';
      currentOnlineSource = list.length ? list[0].key : '';
    }
  }).catch(() => { /* 拉取失败不影响其余功能 */ });
}

function onOnlineSourceChange() {
  const sel = document.getElementById('onlineSourceSelect');
  if (sel) currentOnlineSource = sel.value;
}

// 在线图片走代理，统一加 token 与 source（source 缺省时由后端按 URL 自动路由）
function onlineImgUrl(rawUrl) {
  const src = currentOnlineSource ? `&source=${encodeURIComponent(currentOnlineSource)}` : '';
  return `/api/online/img?url=${encodeURIComponent(rawUrl)}&token=${encodeURIComponent(getToken())}${src}`;
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
  const src = c._source || currentOnlineSource || '';
  const badge = src ? `<span class="online-src-badge">${escHtml(src)}</span>` : '';
  const _k = queueKey(c.id, src);
  onlineCache[_k] = { title: c.title || '', cover: c.cover || '' };
  const _q = inQueue(c.id, src);
  return `<div class="manga-card" onclick="handleOnlineCardTap('${escHtml(c.id)}','${escHtml(src)}',this)" oncontextmenu="event.preventDefault();longPressQueue('${escHtml(c.id)}','${escHtml(src)}',this)">
    <div class="manga-cover-wrap">
      <div class="vol-check" style="display:${_q ? 'flex' : 'none'};position:absolute;top:6px;right:6px;z-index:3;width:20px;height:20px;border-radius:50%;background:#0A84FF;color:#fff;align-items:center;justify-content:center;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,.4)">${ico('check')}</div>
      ${cover ? `<img src="${cover}" class="manga-cover" alt="" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>' + ico('book') + '</div>'">`
        : `<div class="placeholder-cover">${escHtml(title.slice(0, 2))}</div>`}
      ${badge}
    </div>
    <div class="manga-meta-wrapper">
      <div class="title">${escHtml(title)}</div>
      ${author ? `<div class="author">${ico('pen')} ${escHtml(author)}</div>` : ''}
    </div>
  </div>`;
}

async function onlineOpenAlbum(id, source) {
  if (source) currentOnlineSource = source;
  detailBackPage = 'online';
  const el = document.getElementById('detailContent');
  if (el) el.innerHTML = '<div class="profile-loading">加载中…</div>';
  switchPage('detail');
  try {
    const qs = currentOnlineSource ? `?source=${encodeURIComponent(currentOnlineSource)}` : '';
    const res = await api(`/api/online/album/${encodeURIComponent(id)}${qs}`);
    const data = await res.json();
    if (!res.ok) { if (el) el.innerHTML = `<div class="empty-state"><p>${escHtml(data.error || '加载失败')}</p></div>`; return; }
    renderOnlineDetail(data);
  } catch (err) {
    if (err.message === '登录已过期') return;
    if (el) el.innerHTML = '<div class="empty-state"><p>详情加载失败</p></div>';
  }
}

function renderOnlineDetail(a) {
  if (a._source) currentOnlineSource = a._source;
  currentOnlineAlbum = a; // 供「下载到库」复用（标题/作者/标签/源）
  const cover = a.cover ? onlineImgUrl(a.cover) : '';
  const tags = [].concat(a.tags && a.tags.author || [], a.tags && a.tags.tags || [], a.tags && a.tags.works || [], a.tags && a.tags.actors || []);
  const tagHtml = tags.map(t => `<span class="detail-tag">${escHtml(t)}</span>`).join('');
  const chapters = a.chapters || [];
  const chapterHtml = chapters.map(ch => `
    <div class="volume-item" style="display:flex;align-items:center;gap:8px"
      onclick="onlineOpenChapter('${escHtml(ch.id)}','${escHtml(a.title).replace(/'/g, "\\'")}','${escHtml(ch.title).replace(/'/g, "\\'")}','${escHtml(a._source || '')}')">
      <div class="volume-info" style="flex:1;min-width:0">
        <div class="volume-name">${escHtml(ch.title)}</div>
      </div>
      <button style="flex:none;background:transparent;border:1px solid var(--border,#333);color:var(--muted,#aaa);border-radius:8px;padding:5px 9px;font-size:13px;line-height:1;cursor:pointer"
        title="下载本话到本地库"
        onclick="event.stopPropagation();dlOnlineChapter('${escHtml(ch.id)}','${escHtml(ch.title).replace(/'/g, "\\'")}')">${ico('download')}</button>
    </div>`).join('');

  let html = `
    <button class="detail-back" onclick="showDetailBack()" aria-label="返回">${ico('arrow-left')}</button>
    <div class="detail-hero">
      <div class="detail-cover">
        ${cover ? `<img src="${cover}" alt="" loading="lazy" decoding="async" onerror="this.parentElement.innerHTML='<div class=placeholder-cover>' + ico('book') + '</div>'">` : `<div class="placeholder-cover">${ico('book')}</div>`}
      </div>
      <div class="detail-meta-col">
        <div class="detail-title">${escHtml(a.title)}</div>
        ${a.author ? `<div class="detail-sub">作者：${escHtml(a.author)}</div>` : ''}
        ${a.likes ? `<div class="detail-sub">${ico('heart', 'fill')} ${a.likes}</div>` : ''}
        ${a.updateDate ? `<div class="detail-sub">更新：${escHtml(a.updateDate)}</div>` : ''}
        ${tagHtml ? `<div class="detail-tags">${tagHtml}</div>` : ''}
        <button class="detail-start" onclick="onlineOpenChapter('${escHtml(chapters[0] ? chapters[0].id : a.id)}','${escHtml(a.title).replace(/'/g, "\\'")}','${escHtml(chapters[0] ? chapters[0].title : '第1話').replace(/'/g, "\\'")}','${escHtml(a._source || '')}')">开始阅读</button>
        <button class="detail-start" style="background:rgba(255,255,255,0.08);color:var(--text,#eaeaea);margin-top:10px"
          onclick="dlOnlineAlbum()">${ico('download')} 下载到库（${chapters.length} 话）</button>
        <button class="detail-start" style="background:transparent;border:1px solid var(--border,#333);color:var(--muted,#aaa);margin-top:8px"
          onclick="toggleQueue('${escHtml(a.id)}','${escHtml(a._source || '')}',this)">${inQueue(a.id, a._source) ? ico('check') + ' 已在下载清单' : ico('plus') + ' 加入下载清单'}</button>
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

async function onlineOpenChapter(epId, title, chapterTitle, source) {
  if (source) currentOnlineSource = source;
  try {
    const qs = currentOnlineSource ? `?source=${encodeURIComponent(currentOnlineSource)}` : '';
    const res = await api(`/api/online/chapter/${encodeURIComponent(epId)}${qs}`);
    const data = await res.json();
    if (!res.ok) { toast(data.error || '章节加载失败'); return; }
    const images = data.images || [];
    if (images.length === 0) { toast('该章节无图片'); return; }
    openReader({
      id: 'jm-' + epId,
      name: chapterTitle && chapterTitle !== '第1話' ? `${title} ${chapterTitle}` : title,
      ext: 'cbz',
      online: true,
      source: currentOnlineSource,
      images,
      pageCount: images.length,
    });
  } catch (err) {
    if (err.message === '登录已过期') return;
    toast('章节加载出错：' + (err.message || err));
  }
}

// 在线章节 → 本地库（下载/入库）
// 在线阅读逐张走代理，慢且受源站可用性影响；下载入库后可走本地 PDF 通道高速阅读。
let currentOnlineAlbum = null;
let _dlJobId = null;
let _dlTimer = null;

// 详情页：下载整本
function dlOnlineAlbum() {
  const a = currentOnlineAlbum;
  if (!a) return;
  const eps = (a.chapters || []).map(ch => ({ id: ch.id, title: ch.title }));
  if (!eps.length) { toast('没有可下载的章节'); return; }
  startOnlineDownload(a.title, eps, a);
}

// 详情页：下载单话
function dlOnlineChapter(epId, epTitle) {
  const a = currentOnlineAlbum;
  startOnlineDownload(a ? a.title : epTitle, [{ id: epId, title: epTitle || '' }], a || {});
}

// 阅读器内：下载当前正在看的一话
function dlCurrentOnlineChapter() {
  if (typeof readerState === 'undefined' || !readerState || !readerState.comic) return;
  const c = readerState.comic;
  if (!c.online) return;
  const epId = String(c.id || '').replace(/^jm-/, '');
  if (!epId) { toast('无法识别章节 ID'); return; }
  startOnlineDownload(c.name || epId, [{ id: epId, title: '' }], { _source: c.source, title: c.name });
}

async function startOnlineDownload(albumTitle, episodes, album) {
  if (_dlJobId) { toast('已有下载任务进行中，请等待完成'); return; }
  const body = {
    source: (album && (album._source || album.source)) || currentOnlineSource || '',
    albumTitle: albumTitle || '',
    sourceId: (album && album.id) ? String(album.id) : '',
    authors: (album && album.tags && album.tags.author) || (album && album.author ? [album.author] : []),
    tags: (album && album.tags && album.tags.tags) || [],
    episodes,
  };
  dlModalShow(albumTitle, episodes.length);
  try {
    const res = await api('/api/online/download', { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { dlModalError(data.error || '创建下载任务失败'); return; }
    _dlJobId = data.jobId;
    pollDownload(_dlJobId);
  } catch (err) {
    if (err.message === '登录已过期') return;
    dlModalError(err.message || '网络错误');
  }
}

function pollDownload(jobId) {
  clearInterval(_dlTimer);
  _dlTimer = setInterval(async () => {
    let j = null;
    try {
      const res = await api('/api/online/download/' + encodeURIComponent(jobId));
      j = await res.json();
      if (!res.ok) throw new Error(j.error || '查询失败');
    } catch (err) {
      if (err.message === '登录已过期') { stopDlPoll(); return; }
      dlModalError(err.message || '查询失败');
      stopDlPoll();
      return;
    }
    dlModalUpdate(j);
    if (j.status === 'done') {
      stopDlPoll();
      if (_dlDoneResolve) { const _r = _dlDoneResolve; _dlDoneResolve = null; _r(); }
      toast(ico('check-circle') + ' 已入库：' + (j.files || []).join('、'));
      loadAllData(true, currentTab);   // 强制刷新库，新书立刻可见
      setTimeout(dlModalHide, 2200);
    } else if (j.status === 'error') {
      stopDlPoll();
      if (_dlDoneResolve) { const _r = _dlDoneResolve; _dlDoneResolve = null; _r(); }
      toast('下载失败：' + (j.error || '未知错误'));
    }
  }, 1200);
}

function stopDlPoll() {
  clearInterval(_dlTimer);
  _dlTimer = null;
  _dlJobId = null;
}

// 下载进度弹窗（动态创建，避免改动挂载的 index.html）
function dlModalEnsure() {
  let m = document.getElementById('dlModal');
  if (m) return m;
  m = document.createElement('div');
  m.id = 'dlModal';
  m.className = 'modal-mask';
  m.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">下载到本地库</div>
      <div class="modal-sub" id="dlSub">准备中…</div>
      <div style="height:8px;border-radius:6px;background:rgba(255,255,255,0.08);overflow:hidden;margin:12px 0 6px">
        <div id="dlBar" style="height:100%;width:0;background:linear-gradient(90deg,#ff5b78,#ff8a5b);transition:width .4s"></div>
      </div>
      <div style="font-size:12px;color:var(--muted,#888);min-height:18px" id="dlInfo"></div>
      <div class="modal-actions">
        <button class="modal-btn ghost" onclick="dlModalHide()">后台继续</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  return m;
}
function dlModalShow(title, count) {
  const m = dlModalEnsure();
  const sub = document.getElementById('dlSub');
  if (sub) sub.textContent = `${title || ''} · 共 ${count} 话`;
  const bar = document.getElementById('dlBar');
  if (bar) bar.style.width = '0%';
  const info = document.getElementById('dlInfo');
  if (info) info.textContent = '正在创建任务…';
  m.style.display = 'flex';
}
function dlModalUpdate(j) {
  const bar = document.getElementById('dlBar');
  if (bar) bar.style.width = (j.overall || 0) + '%';
  const info = document.getElementById('dlInfo');
  if (info) {
    const ep = j.epCount > 1 ? `第 ${j.epIndex}/${j.epCount} 话 · ` : '';
    const pg = j.pageTotal ? `${j.pageDone}/${j.pageTotal} 页 · ` : '';
    info.textContent = ep + pg + (j.message || '');
  }
}
function dlModalError(msg) {
  stopDlPoll();
  const info = document.getElementById('dlInfo');
  if (info) info.innerHTML = ico('x-circle') + ' ' + escHtml(String(msg));
}
function dlModalHide() {
  const m = document.getElementById('dlModal');
  if (m) m.style.display = 'none';
}

// hash 路由（2026-09-02）
function applyRoute(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (!h) { switchPage('comic'); return; }
  const m = h.match(/^reader\/(.+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!readerState || readerState.comic.id !== id) {
      openReaderById(id);
    }
    return;
  }
  const dm = h.match(/^detail\/(.+)$/);
  if (dm) {
    const did = decodeURIComponent(dm[1]);
    if (!currentDetailComic || String(currentDetailComic.sourceId || currentDetailComic.id) !== did) {
      showDetailForComic(did);
    }
    return;
  }
  const tabs = ['comic','novel','all','online','ranking','profile','detail'];
  if (tabs.includes(h)) { switchPage(h); }
  else { switchPage('comic'); }
}
window.addEventListener('hashchange', () => { applyRoute(location.hash); });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { applyRoute(location.hash); });
} else {
  setTimeout(function () { applyRoute(location.hash); }, 200);
}

// 动量追踪器
function attachHorizontalScrollPhysics() {
  const scroller = document.querySelector('.rec-scroll');
  if (!scroller || scroller._hasPhysics) return;
  scroller._hasPhysics = true;

  let lastX = scroller.scrollLeft;
  let lastTime = performance.now();
  let velocity = 0;
  let currentTilt = 0;
  let rafId = null;

  function updatePhysics() {
    currentTilt += (velocity - currentTilt) * 0.15;
    velocity *= 0.82; // 动量摩擦衰减系数

    const clampedTilt = Math.abs(currentTilt) < 0.05 ? 0 : Math.max(-15, Math.min(15, currentTilt));
    scroller.style.setProperty('--scroll-tilt', `${clampedTilt.toFixed(2)}deg`);
    scroller.style.setProperty('--scroll-skew', `${(clampedTilt * -0.3).toFixed(2)}deg`);

    if (Math.abs(velocity) > 0.05 || Math.abs(currentTilt) > 0.05) {
      rafId = requestAnimationFrame(updatePhysics);
    } else {
      currentTilt = 0;
      scroller.style.setProperty('--scroll-tilt', '0deg');
      scroller.style.setProperty('--scroll-skew', '0deg');
      rafId = null;
    }
  }

  scroller.addEventListener('scroll', () => {
    const now = performance.now();
    const dt = Math.max(1, now - lastTime);
    const dx = scroller.scrollLeft - lastX;

    const instantVelocity = (dx / dt) * 16.6;
    velocity = Math.max(-20, Math.min(20, instantVelocity));

    lastX = scroller.scrollLeft;
    lastTime = now;

    if (!rafId) {
      rafId = requestAnimationFrame(updatePhysics);
    }
  }, { passive: true });
}

/* 阅读器返回体验增强：视觉瞬时退出 + 显存异步回收 */
// 递增令牌：teardown 执行前若用户已打开另一本，则放弃本次收尾，避免误关新书
let _closeReaderToken = 0;

function closeReaderFast() {
  const readerEl = document.getElementById('reader');
  if (!readerEl || readerEl.style.display === 'none') return;

  // 阶段 1 (0ms 第一帧)：立即切断视觉并屏蔽交互，无缝透出底层书架
  readerEl.classList.add('exiting');
  removeFloatingBackButton();

  // 退出全屏状态（若处于全屏模式）
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  // 触发内存级进度局部更新（禁止整库 reload）
  if (typeof updateLocalProgressAfterRead === 'function') {
    updateLocalProgressAfterRead();
  }

  const token = ++_closeReaderToken;

  // 阶段 2 (延后 150ms / 空闲周期)：卸载 Canvas + 复用核心 closeReader 收尾
  const teardown = () => {
    if (token !== _closeReaderToken) return; // 期间已打开新阅读器，放弃本次收尾

    // 释放阅读器已持有的 canvas 显存
    readerEl.querySelectorAll('canvas').forEach(cv => {
      cv.width = 1;
      cv.height = 1;
      const ctx = cv.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, 1, 1);
    });

    // 复用 reader.js 的核心 closeReader，完成
    //   pdfDoc.destroy() + readerState 重置 + 进度保存 + 路由修正 + 回详情/书架。
    //   早期实现只做视觉隐藏，状态常驻 → 下一本复用上一本的 PDF 文档（「看完一本看不了下一本」）。
    //   注意：app.js 先于 reader.js 加载，故此处运行时通过 window.__coreCloseReader 取。
    if (typeof window.__coreCloseReader === 'function') {
      window.__coreCloseReader();
    }
    // 清除动画态（核心逻辑不认识 .exiting）
    readerEl.classList.remove('exiting');
    readerEl.style.display = 'none';
  };

  if (window.requestIdleCallback) {
    setTimeout(() => requestIdleCallback(teardown), 150);
  } else {
    setTimeout(teardown, 150);
  }
}

// 覆盖旧有的 closeReader 接口，保持对外兼容
window.closeReader = closeReaderFast;
// 物理手势与 popstate 极速拦截
window.addEventListener('popstate', (e) => {
  const readerEl = document.getElementById('reader');
  const isReaderActive = readerEl && readerEl.style.display !== 'none' && !readerEl.classList.contains('exiting');

  // 如果当前处于阅读器状态，物理后退优先无感退出阅读器
  if (isReaderActive) {
    if (typeof closeReaderFast === 'function') {
      closeReaderFast();
    }
    // 已完成退出，阻止后续冗余页面重刷
    return;
  }
});
// 内存级乐观更新进度，杜绝退出阅读器时全量触发 3 次 library API
function updateLocalProgressAfterRead() {
  if (!readerState || !readerState.comic) return;
  const cId = readerState.comic.id;
  const curPage = readerState.currentPage || 1;
  const total = readerState.totalPages || readerState.comic.pageCount || 1;

  // 1. 遍历就地修改内存对象
  const all = allSeriesArrays().flatMap(s => (s.items || []));
  const target = all.find(c => c.id === cId || String(c.sourceId) === String(cId));
  if (target) {
    if (!target.progress) target.progress = {};
    target.progress.page = curPage;
    target.progress.totalPages = total;
    target.progress.updatedAt = new Date().toISOString();
  }

  // 2. 仅刷新“继续阅读”卡片，DOM 变动极小
  const flatComics = (allSeries[currentTab] || allSeries.comic || []).flatMap(s => s.items || []);
  const contId = currentTab === 'novel' ? 'continueNovel' : (currentTab === 'all' ? 'continueAll' : 'continueComic');
  const contEl = $(contId);

  if (contEl && flatComics.length > 0) {
    const withProgress = flatComics
      .filter(c => c.progress && c.progress.page > 0)
      .sort((a, b) => new Date(b.progress.updatedAt || 0) - new Date(a.progress.updatedAt || 0))
      .slice(0, 1);

    if (withProgress.length > 0 && typeof renderContinueCard === 'function') {
      contEl.innerHTML = renderContinueCard(withProgress[0]);
      contEl.style.display = 'block';
    }
  }

  // 3. 将同步请求降级为静默心跳上报
  fetch(`/api/comic/${cId}/progress`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`
    },
    body: JSON.stringify({ page: curPage, totalPages: total })
  }).catch(() => {});
}
// 悬浮返回胶囊生命周期管理
let _readerBackTimer = null;

function ensureFloatingBackButton() {
  /* 【2026-09-22 修正】
     胶囊不是「重复按钮」，而是顶栏被折叠（点空白处会自动折叠）时**唯一的返回入口**。
     上一版直接删掉它，导致顶栏一折叠用户就找不到返回键。
     现改为「与顶栏互补」：顶栏可见时隐藏胶囊，顶栏折叠时才显示 —— 两者永不同时出现，
     既不会有重叠的双 ← ，也不会在顶栏折叠后失去返回能力。 */
  let btn = document.getElementById('readerFloatingBack');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'readerFloatingBack';
    btn.className = 'reader-floating-back';
    btn.setAttribute('aria-label', '返回书架');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    `;
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      // 【2026-09-22】直接退出阅读器。原实现优先 history.back()，
      // 在无历史条目（深链直开 / PWA 冷启）时毫无反应，用户以为按钮坏了。
      // 用 closeReader() 归一，它内部已处理「在线→在线详情 / 本地→同系列详情」的分支。
      if (typeof closeReader === 'function') {
        closeReader();
      } else {
        history.back();
      }
    };
    document.body.appendChild(btn);

    /* 【2026-09-22】移除旧的「闲置 3 秒转幽灵态 + 交互唤醒」逻辑：
       它导致按钮看起来会自己消失/变淡；现在显隐完全由 setFloatingBackVisible 控制。 */
  }

  return btn;
}

/**
 * 【2026-09-22】按顶栏显隐状态同步胶囊：controlsVisible=true（顶栏在）→ 藏胶囊。
 * 由 reader.js 的控制栏切换逻辑调用，保证两者互斥显示。
 */
function setFloatingBackVisible(visible) {
  clearTimeout(_readerBackTimer);
  if (visible) {
    const btn = ensureFloatingBackButton();
    btn.style.display = 'flex';
    btn.classList.remove('ghost');
  } else {
    const btn = document.getElementById('readerFloatingBack');
    if (btn) {
      btn.style.display = 'none';
      btn.classList.add('ghost');
    }
  }
}

function removeFloatingBackButton() {
  clearTimeout(_readerBackTimer);
  const btn = document.getElementById('readerFloatingBack');
  /* 【2026-09-22】改为真正移除节点。原来只 display:none，残留节点会被后续代码
     或旧逻辑重新显示，造成「点一次消失、再进又出现」。 */
  if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  else if (btn) btn.style.display = 'none';
}
