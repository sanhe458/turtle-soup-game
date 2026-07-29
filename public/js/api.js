// 前端 API 封装
(function () {
  const API_BASE = window.API_BASE || '/api';
  // 运行时防护：HTTPS 页面下若解析到的 base 仍为 http:，输出告警以避免混合内容
  function warnIfMixedContent(base) {
    if (window.location.protocol === 'https:' && /^http:\/\//.test(base)) {
      console.warn('[api.js] 检测到混合内容风险：HTTPS 页面使用了 http: 的 API base (' + base + ')');
    }
  }
  warnIfMixedContent(API_BASE);
  const TOKEN_KEY = 'ts_user_token';
  const USER_KEY = 'ts_user_info';
  const ADMIN_TOKEN_KEY = 'ts_admin_token';
  const ADMIN_INFO_KEY = 'ts_admin_info';

  const Api = {
    API_BASE,

    // ===== 用户 token =====
    getUserToken() {
      return localStorage.getItem(TOKEN_KEY) || '';
    },
    setUserToken(token, info) {
      localStorage.setItem(TOKEN_KEY, token);
      if (info) localStorage.setItem(USER_KEY, JSON.stringify(info));
    },
    getUserInfo() {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    clearUser() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },

    // ===== 管理员 token =====
    getAdminToken() {
      return localStorage.getItem(ADMIN_TOKEN_KEY) || sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
    },
    setAdminToken(token, info, remember) {
      // 始终写入 localStorage 避免 sessionStorage 在页面跳转时丢失
      const store = localStorage;
      store.setItem(ADMIN_TOKEN_KEY, token);
      if (info) localStorage.setItem(ADMIN_INFO_KEY, JSON.stringify(info));
    },
    getAdminInfo() {
      try {
        return JSON.parse(localStorage.getItem(ADMIN_INFO_KEY) || 'null');
      } catch {
        return null;
      }
    },
    clearAdmin() {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      localStorage.removeItem(ADMIN_INFO_KEY);
    },

    // ===== fetch 封装 =====
    async request(method, path, body, opts = {}) {
      const url = API_BASE + path;
      const headers = { 'Content-Type': 'application/json' };
      if (opts.admin) {
        const t = Api.getAdminToken();
        if (t) headers.Authorization = 'Bearer ' + t;
      } else if (opts.user !== false) {
        const t = Api.getUserToken();
        if (t) headers.Authorization = 'Bearer ' + t;
      }
      const fetchOpts = { method, headers };
      if (body !== undefined && body !== null) {
        fetchOpts.body = JSON.stringify(body);
      }
      try {
        const res = await fetch(url, fetchOpts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          const err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.body = data;
          throw err;
        }
        return data;
      } catch (err) {
        if (err.status === 401) {
          if (opts.admin) {
            Api.clearAdmin();
            if (location.pathname.indexOf('admin-login') === -1) {
              location.href = './admin-login';
            }
          } else if (opts.user !== false) {
            // 用户 401 不强制跳转，由调用方处理
          }
        }
        throw err;
      }
    },

    // ===== 用户端 API =====
    register(nickname) {
      return Api.request('POST', '/users/register', { nickname }, { user: false });
    },
    getProfile() {
      return Api.request('GET', '/user/profile');
    },
    getRecentGames() {
      return Api.request('GET', '/user/recent-games');
    },
    getReveal(gameId) {
      return Api.request('GET', '/game/' + encodeURIComponent(gameId) + '/reveal');
    },
    getPuzzle(id) {
      return Api.request('GET', '/puzzles/' + encodeURIComponent(id), null, { user: false });
    },

    // ===== 管理端 API =====
    adminLogin(account, password) {
      return Api.request('POST', '/admin/login', { account, password }, { user: false });
    },
    adminDashboard(range) {
      const qs = range ? '?range=' + range : '';
      return Api.request('GET', '/admin/dashboard' + qs, null, { admin: true });
    },
    adminListPuzzles(params) {
      const qs = new URLSearchParams(params).toString();
      return Api.request('GET', '/admin/puzzles' + (qs ? '?' + qs : ''), null, { admin: true });
    },
    adminCreatePuzzle(data) {
      return Api.request('POST', '/admin/puzzles', data, { admin: true });
    },
    adminUpdatePuzzle(id, data) {
      return Api.request('PUT', '/admin/puzzles/' + encodeURIComponent(id), data, { admin: true });
    },
    adminUpdatePuzzleStatus(id, status) {
      return Api.request('PATCH', '/admin/puzzles/' + encodeURIComponent(id) + '/status', { status }, { admin: true });
    },

    // ===== 管理端 AI 配置 =====
    // 供应商
    adminListProviders() {
      return Api.request('GET', '/admin/ai/providers', null, { admin: true });
    },
    adminCreateProvider(data) {
      return Api.request('POST', '/admin/ai/providers', data, { admin: true });
    },
    adminUpdateProvider(id, data) {
      return Api.request('PUT', '/admin/ai/providers/' + encodeURIComponent(id), data, { admin: true });
    },
    adminDeleteProvider(id) {
      return Api.request('DELETE', '/admin/ai/providers/' + encodeURIComponent(id), null, { admin: true });
    },
    // 模型
    adminListModels(providerId) {
      const qs = providerId ? '?providerId=' + encodeURIComponent(providerId) : '';
      return Api.request('GET', '/admin/ai/models' + qs, null, { admin: true });
    },
    adminCreateModel(data) {
      return Api.request('POST', '/admin/ai/models', data, { admin: true });
    },
    adminUpdateModel(id, data) {
      return Api.request('PUT', '/admin/ai/models/' + encodeURIComponent(id), data, { admin: true });
    },
    adminDeleteModel(id) {
      return Api.request('DELETE', '/admin/ai/models/' + encodeURIComponent(id), null, { admin: true });
    },
    // 角色
    adminListRoles() {
      return Api.request('GET', '/admin/ai/roles', null, { admin: true });
    },
    adminCreateRole(data) {
      return Api.request('POST', '/admin/ai/roles', data, { admin: true });
    },
    adminUpdateRole(id, data) {
      return Api.request('PUT', '/admin/ai/roles/' + encodeURIComponent(id), data, { admin: true });
    },
    adminDeleteRole(id) {
      return Api.request('DELETE', '/admin/ai/roles/' + encodeURIComponent(id), null, { admin: true });
    },
    // 角色绑定与策略
    adminGetRoleModels(id) {
      return Api.request('GET', '/admin/ai/roles/' + encodeURIComponent(id) + '/models', null, { admin: true });
    },
    adminUpdateRoleModels(id, bindings) {
      return Api.request('PUT', '/admin/ai/roles/' + encodeURIComponent(id) + '/models', { bindings }, { admin: true });
    },
    adminUpdateRoleStrategy(id, strategy) {
      return Api.request('PATCH', '/admin/ai/roles/' + encodeURIComponent(id) + '/strategy', { strategy }, { admin: true });
    },
    // 测试
    adminTestAI(modelId, prompt) {
      return Api.request('POST', '/admin/ai/test', { modelId, prompt }, { admin: true });
    },
  };

  window.Api = Api;
})();
