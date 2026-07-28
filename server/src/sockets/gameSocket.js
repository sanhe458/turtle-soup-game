const gameService = require('../services/gameService');

function attachGameHandlers(io, socket, socketUserMap) {
  socket.on('game:question', async ({ question } = {}) => {
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      socket.emit('error', { message: '提问不能为空' });
      return;
    }
    if (question.trim().length > 200) {
      socket.emit('error', { message: '提问过长（最多 200 字）' });
      return;
    }
    const found = gameService.getGameBySocketId(socket.id);
    if (!found) {
      socket.emit('error', { message: '你不在任何对局中' });
      return;
    }
    const { gameId, state } = found;
    const player = state.players.find((p) => p.socketId === socket.id);
    if (!player) {
      socket.emit('error', { message: '玩家信息丢失' });
      return;
    }
    if (state.currentSeat !== player.seat) {
      socket.emit('error', { message: '当前不是你的回合' });
      return;
    }
    const result = await gameService.receiveQuestion(gameId, player.seat, question.trim(), io, false);
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
