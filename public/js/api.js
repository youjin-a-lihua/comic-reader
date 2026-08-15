/**
 * 前端 API 封装
 * 自动处理 JWT token 和错误
 */

const API_BASE = window.location.origin;

function getToken() {
  return localStorage.getItem('fn_comic_token');
}

// 全局请求超时：避免磁盘 I/O 卡顿（HC620/sda 偶发 EIO）时前端永远 pending
const API_TIMEOUT_MS = 20000;

async function api(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    'Authorization': `Bearer ${token}`
  };

  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      throw new Error('请求超时（漫画盘可能暂时性 I/O 繁忙，请重试）');
    }
    throw e;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    localStorage.removeItem('fn_comic_token');
    localStorage.removeItem('fn_comic_user');
    window.location.href = '/';
    throw new Error('登录已过期');
  }

  return res;
}

// 便捷 API 方法
const ComicAPI = {
  login(username, password) {
    return fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
  },

  async getLibrary(type, force) {
    const q = [];
    if (type) q.push('type=' + type);
    if (force) q.push('refresh=1');
    const res = await api('/api/library' + (q.length ? '?' + q.join('&') : ''));
    return res.json();
  },

  async getShelves() {
    const res = await api('/api/shelves');
    return res.json();
  },

  async getComments(id) {
    const res = await api(`/api/comic/${id}/comments`);
    return res.json();
  },
  async postComment(id, payload) {
    const res = await api(`/api/comic/${id}/comments`, { method: 'POST', body: payload });
    return res.json();
  },

  async createShelf(name) {
    const res = await api('/api/shelves', { method: 'POST', body: { name } });
    return res.json();
  },

  async updateShelf(id, data) {
    const res = await api(`/api/shelves/${id}`, { method: 'PUT', body: data });
    return res.json();
  },

  async getShelf(id) {
    const res = await api('/api/shelves/' + id);
    return res.json();
  },

  async deleteShelf(id) {
    const res = await api(`/api/shelves/${id}`, { method: 'DELETE' });
    return res.json();
  },

  async getContinue() {
    const res = await api('/api/continue');
    return res.json();
  },

  async getBookmarks() {
    const res = await api('/api/bookmarks');
    return res.json();
  },

  async search(q) {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    return res.json();
  },

  async getComicInfo(id) {
    const res = await api(`/api/comic/${id}/info`);
    return res.json();
  },

  getFileUrl(id) {
    return `${API_BASE}/api/comic/${id}/file`;
  },

  getPageUrl(id, num) {
    return `${API_BASE}/api/comic/${id}/page/${num}`;
  },

  getCoverUrl(id) {
    const token = getToken();
    return `${API_BASE}/api/comic/${id}/cover?token=${encodeURIComponent(token)}`;
  },

  async saveProgress(id, page, totalPages) {
    const res = await api(`/api/comic/${id}/progress`, {
      method: 'POST',
      body: { page, totalPages }
    });
    return res.json();
  },

  async toggleBookmark(id) {
    const res = await api(`/api/comic/${id}/bookmark`, { method: 'POST' });
    return res.json();
  },
  async getAstrbotConfig() {
    const res = await api('/api/astrbot/config');
    return res.json();
  },
  async saveAstrbotConfig(cfg) {
    const res = await api('/api/astrbot/config', { method: 'POST', body: cfg });
    return res.json();
  },
  // opts: { command } 直接透传完整指令，或兼容旧的 { query, type }
  async sendAstrbotCommand(opts) {
    const res = await api('/api/astrbot/command', { method: 'POST', body: opts });
    return res.json();
  },
  // 轮询 AstrBot 会话历史（详情/进度/图片）
  async getAstrbotSession(sessionId) {
    const res = await api('/api/astrbot/session/' + encodeURIComponent(sessionId), { method: 'GET' });
    return res.json();
  }
};
