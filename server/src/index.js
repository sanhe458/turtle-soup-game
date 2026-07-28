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

// Socket.IO
setupMatchSockets(io);

server.listen(config.port, () => {
  console.log(`[turtle-soup] Server running on port ${config.port}`);
  console.log(`[turtle-soup] CORS origin: ${config.clientOrigin}`);
  console.log(`[turtle-soup] Socket.IO ready`);
  if (!config.zhipu.apiKey) {
    console.warn('[turtle-soup] WARNING: ZHIPU_API_KEY 未配置，AI 判定将降级为"无关"');
  }
});
