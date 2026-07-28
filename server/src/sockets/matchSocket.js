const { verify } = require('../utils/jwt');
const matchService = require('../services/matchService');
const gameService = require('../services/gameService');

// socketId -> { userId, nickname } 的临时映射（用于断线清理）
const socketUserMap = new Map();

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
    socket.on('match:join', ({ token } = {}) => {
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
      matchService.enqueue(socket.id, user.userId, user.nickname, socket);
    });

    socket.on('match:cancel', () => {
      matchService.cancel(socket.id);
    });

    socket.on('match:accept_bots', () => {
      matchService.acceptBots(socket.id);
    });

    socket.on('match:decline_bots', () => {
      matchService.declineBots(socket.id);
    });

    // game 事件委托给 gameSocket
    require('./gameSocket').attachGameHandlers(io, socket, socketUserMap);

    socket.on('disconnect', () => {
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
