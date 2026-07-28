const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const config = require('./config');
const db = require('./db');
const aiConfig = require('./services/aiConfigService');
const { setupMatchSockets } = require('./sockets/matchSocket');

const app = express();
app.set('trust proxy', 1);

// CORS 来源校验：禁止使用通配符或空值
if (!config.clientOrigin || config.clientOrigin === '*') {
  console.warn('[turtle-soup] WARNING: CLIENT_ORIGIN 未配置或为 "*"，请显式指定允许的前端来源');
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdn.socket.io'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json({ limit: '100kb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api', apiLimiter);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 路由
app.use('/api', require('./routes/userRoutes'));
app.use('/api', require('./routes/puzzleRoutes'));
app.use('/api', require('./routes/adminRoutes'));
app.use('/api', require('./routes/aiRoutes'));

// Socket.IO
setupMatchSockets(io);

// 全局错误处理中间件：必须放在所有路由之后，避免泄漏错误堆栈
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: '服务器内部错误' });
});

// 异步启动：先初始化数据库 schema，再监听端口
async function boot() {
  await db.initSchema();
  server.listen(config.port, () => {
    console.log(`[turtle-soup] Server running on port ${config.port}`);
    console.log(`[turtle-soup] CORS origin: ${config.clientOrigin}`);
    console.log(`[turtle-soup] Socket.IO ready`);
  });
  if (!(await aiConfig.hasEnabledProvider())) {
    console.warn('[turtle-soup] WARNING: 未配置任何启用的 AI 供应商，AI 角色将走降级逻辑（请在管理后台「AI 配置」页面维护）');
  }
}

boot().catch((err) => {
  console.error('[turtle-soup] 启动失败:', err.message);
  process.exit(1);
});
