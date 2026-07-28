// Socket.IO 客户端单例
(function () {
  const SOCKET_BASE = window.SOCKET_BASE || '';
  // 运行时防护：HTTPS 页面下若解析到的 base 仍为 http:，输出告警以避免混合内容
  function warnIfMixedContent(base) {
    if (window.location.protocol === 'https:' && /^http:\/\//.test(base)) {
      console.warn('[socket.js] 检测到混合内容风险：HTTPS 页面使用了 http: 的 Socket base (' + base + ')');
    }
  }
  warnIfMixedContent(SOCKET_BASE);
  let socket = null;

  function getSocket() {
    if (socket) return socket;
    if (typeof io === 'undefined') {
      console.error('[socket.js] Socket.IO 客户端未加载，请确保引入了 socket.io.js');
      return null;
    }
    const token = (window.Api && Api.getUserToken()) || '';
    socket = io(SOCKET_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
    });
    socket.on('connect', () => {
      console.log('[socket] 已连接', socket.id);
    });
    socket.on('disconnect', (reason) => {
      console.log('[socket] 已断开', reason);
    });
    socket.on('connect_error', (err) => {
      console.warn('[socket] 连接错误', err.message);
    });
    return socket;
  }

  function reconnect() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    return getSocket();
  }

  window.SocketClient = { getSocket, reconnect };
})();
