const gameService = require('../services/gameService');

function attachGameHandlers(io, socket, socketUserMap) {
  socket.on('game:join', ({ gameId, seat } = {}) => {
    if (!gameId) return;
    const state = gameService.getGame(gameId);
    if (!state) {
      socket.emit('error', { message: '对局不存在或已结束' });
      return;
    }
    // 用 seat（座位号）定位玩家
    const player = state.players.find((p) => p.seat === seat);
    if (!player) {
      socket.emit('error', { message: '你不在这场对局中' });
      return;
    }
    // 更新玩家的 socketId
    player.socketId = socket.id;
    socket.join(`game:${gameId}`);

    socket.emit('game:start', {
      gameId,
      puzzle: {
        id: state.puzzle.id, title: state.puzzle.title,
        scenario: state.puzzle.scenario, difficulty: state.puzzle.difficulty,
        tags: state.puzzle.tags, playCount: state.puzzle.playCount,
      },
      players: state.players.map((pl) => ({
        nickname: pl.nickname, seat: pl.seat, isBot: pl.isBot,
        questionsAsked: pl.questionsAsked,
      })),
      maxRounds: state.maxRounds, yourSeat: player.seat,
      currentRound: state.currentRound, currentSeat: state.currentSeat,
    });

    if (state.currentSeat === player.seat) {
      socket.emit('game:turn', {
        seat: state.currentSeat, round: state.currentRound,
        remaining: state.timerRemaining || 0,
      });
    }
  });

  socket.on('game:question', async ({ question } = {}) => {
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      socket.emit('error', { message: '提问不能为空' }); return;
    }
    if (question.trim().length > 200) {
      socket.emit('error', { message: '提问过长（最多 200 字）' }); return;
    }
    const found = gameService.getGameBySocketId(socket.id);
    if (!found) { socket.emit('error', { message: '你不在任何对局中' }); return; }
    const { gameId: gid, state: st } = found;
    const player = st.players.find((p) => p.socketId === socket.id);
    if (!player) { socket.emit('error', { message: '玩家信息丢失' }); return; }
    if (st.currentSeat !== player.seat) {
      socket.emit('error', { message: '当前不是你的回合' }); return;
    }
    const result = await gameService.receiveQuestion(gid, player.seat, question.trim(), io, false);
    if (!result || !result.ok) {
      socket.emit('error', { message: result?.error || '提交失败' });
    }
  });

  socket.on('game:leave', () => {
    const found = gameService.getGameBySocketId(socket.id);
    if (found) {
      gameService.leaveGame(found.gameId, socket.id, io);
      socket.leave(`game:${found.gameId}`);
    }
  });
}

module.exports = { attachGameHandlers };
