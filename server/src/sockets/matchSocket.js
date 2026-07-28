const { verify } = require('../utils/jwt');
const matchService = require('../services/matchService');
const gameService = require('../services/gameService');

// socketId -> { userId, nickname } 的临时映射（用于断线清理）
const socketUserMap = new Map();

// 每 IP 并发连接计数
const ipConnectionCounts = new Map();
const MAX_CONNECTIONS_PER_IP = 10;

// 每套接字事件速率限制（滑动窗口）
const socketEventTimestamps = new Map();
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX_EVENTS = 10;

function isRateLimited(socket) {
  const now = Date.now();
  const timestamps = socketEventTimestamps.get(socket.id) || [];
  // 仅保留窗口内的时间戳
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_EVENTS) {
    socketEventTimestamps.set(socket.id, recent);
    return true;
  }
  recent.push(now);
  socketEventTimestamps.set(socket.id, recent);
  return false;
}

function setupMatchSockets(io) {
  // 注入匹配服务钩子
  matchService.setHooks({
    onMatchSuccess: async (players, isHybrid) => {
      const puzzle = gameService.pickRandomPuzzle();
      if (!puzzle) {
        console.error('[matchSocket] 无可用题目');
        players.forEach((p) => {
          if (p.socketId) io.to(p.socketId).emit('error', { message: '暂无可用题目' });
        });
        return;
      }
      // 构造带 socketId 的 players（真人保留 socketId，bot 为 null）
      const gameId = gameService.createGame(puzzle, players);
      // 把所有真人 socket 加入对局房间
      players.forEach((p) => {
        if (p.socketId) {
          io.sockets.sockets.get(p.socketId)?.join(`game:${gameId}`);
        }
      });
      // 通知匹配成功
      players.forEach((p) => {
        if (p.socketId) {
          io.to(p.socketId).emit('match:success', {
            gameId,
            isHybrid,
            players: players.map((pl) => ({
              nickname: pl.nickname,
              isBot: !!pl.isBot,
            })),
            puzzle: { title: puzzle.title, difficulty: puzzle.difficulty },
          });
        }
      });
      // 启动对局
      gameService.startGame(gameId, io);
    },
    onBotPrompt: (socketId) => {
      io.to(socketId).emit('match:bot_prompt', {
        message: '30 秒未匹配到足够真人，是否接受 AI 机器人补位？',
      });
    },
    onStatusUpdate: (socketId, position, waitedSec) => {
      io.to(socketId).emit('match:status', { position, waitedSec });
    },
    onRemoved: (socketId, reason) => {
      io.to(socketId).emit('match:cancelled', { reason });
    },
  });

  matchService.start();

  io.on('connection', (socket) => {
    // 每 IP 并发连接数限制
    const ip = socket.handshake.address;
    const ipCount = (ipConnectionCounts.get(ip) || 0) + 1;
    if (ipCount > MAX_CONNECTIONS_PER_IP) {
      socket.disconnect(true);
      return;
    }
    ipConnectionCounts.set(ip, ipCount);

    socket.on('match:join', ({ token } = {}) => {
      if (isRateLimited(socket)) {
        socket.emit('error', { message: '请求过于频繁，请稍后再试' });
        return;
      }
      let user;
      try {
        const decoded = verify(token);
        if (decoded.type !== 'user') throw new Error('not user');
        user = { userId: decoded.userId, nickname: decoded.nickname };
      } catch {
        socket.emit('error', { message: '身份凭证无效，请重新输入昵称' });
        return;
      }
      socketUserMap.set(socket.id, user);
      // 多开对局互斥：若当前 socket 已处于某局对局中，则拒绝再次匹配
      const existingGame = gameService.getGameBySocketId(socket.id);
      if (existingGame) {
        socket.emit('error', { message: '您已在游戏中' });
        return;
      }
      matchService.enqueue(socket.id, user.userId, user.nickname, socket);
    });

    socket.on('match:cancel', () => {
      if (!socketUserMap.has(socket.id)) {
        socket.emit('error', { message: '未认证' });
        return;
      }
      if (isRateLimited(socket)) {
        socket.emit('error', { message: '请求过于频繁，请稍后再试' });
        return;
      }
      matchService.cancel(socket.id);
    });

    socket.on('match:accept_bots', () => {
      if (!socketUserMap.has(socket.id)) {
        socket.emit('error', { message: '未认证' });
        return;
      }
      if (isRateLimited(socket)) {
        socket.emit('error', { message: '请求过于频繁，请稍后再试' });
        return;
      }
      matchService.acceptBots(socket.id);
    });

    socket.on('match:decline_bots', () => {
      if (!socketUserMap.has(socket.id)) {
        socket.emit('error', { message: '未认证' });
        return;
      }
      if (isRateLimited(socket)) {
        socket.emit('error', { message: '请求过于频繁，请稍后再试' });
        return;
      }
      matchService.declineBots(socket.id);
    });

    // game 事件委托给 gameSocket
    require('./gameSocket').attachGameHandlers(io, socket, socketUserMap);

    socket.on('disconnect', () => {
      // 释放 IP 连接计数
      const c = ipConnectionCounts.get(ip) || 0;
      if (c <= 1) ipConnectionCounts.delete(ip);
      else ipConnectionCounts.set(ip, c - 1);
      // 清理速率限制记录
      socketEventTimestamps.delete(socket.id);

      matchService.cancel(socket.id);
      // 清理对局中的玩家
      const found = gameService.getGameBySocketId(socket.id);
      if (found) {
        gameService.leaveGame(found.gameId, socket.id, io);
      }
      socketUserMap.delete(socket.id);
    });
  });
}

module.exports = { setupMatchSockets, socketUserMap };
