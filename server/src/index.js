const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const config = require('./config');
const { setupMatchSockets } = require('./sockets/matchSocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
});

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

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

server.listen(config.port, () => {
  console.log(`[turtle-soup] Server running on port ${config.port}`);
  console.log(`[turtle-soup] CORS origin: ${config.clientOrigin}`);
  console.log(`[turtle-soup] Socket.IO ready`);
  const aiConfig = require('./services/aiConfigService');
  if (!aiConfig.hasEnabledProvider()) {
    console.warn('[turtle-soup] WARNING: 未配置任何启用的 AI 供应商，AI 角色将走降级逻辑（请在管理后台「AI 配置」页面维护）');
  }
});
