const config = require('../config');
const botService = require('./botService');

// 匹配队列：FIFO
// 每项 = { socketId, userId, nickname, joinedAt, botPrompted, socket }
const queue = [];
let tickInterval = null;

// 回调钩子（由 sockets/matchSocket.js 注入）
const hooks = {
  onMatchSuccess: null,        // (players, isHybrid) => Promise<gameId>
  onBotPrompt: null,           // (socketId) => void
  onStatusUpdate: null,        // (socketId, position, waitedSec) => void
  onRemoved: null,             // (socketId, reason) => void
};

function setHooks(h) {
  Object.assign(hooks, h);
}

function start() {
  if (tickInterval) return;
  tickInterval = setInterval(tick, 1000);
}

function stop() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function tick() {
  const now = Date.now();
  // 1) 尝试凑齐 3 个真人
  while (queue.length >= config.game.playersPerGame) {
    const players = queue.splice(0, config.game.playersPerGame);
    if (hooks.onMatchSuccess) {
      hooks.onMatchSuccess(players, false).catch((err) => {
        console.error('[matchService] onMatchSuccess 失败:', err);
      });
    }
  }
  // 2) 检查每个等待者是否到 30 秒
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const waitedSec = Math.floor((now - item.joinedAt) / 1000);
    if (hooks.onStatusUpdate) {
      hooks.onStatusUpdate(item.socketId, i + 1, waitedSec);
    }
    if (waitedSec >= config.game.matchTimeoutSec && !item.botPrompted) {
      item.botPrompted = true;
      if (hooks.onBotPrompt) hooks.onBotPrompt(item.socketId);
    }
  }
}

function enqueue(socketId, userId, nickname, socket) {
  // 已在队列则忽略
  if (queue.find((q) => q.socketId === socketId)) return false;
  // userId 去重：同一用户不能重复入队
  if (userId && queue.find((q) => q.userId === userId)) return false;
  // TODO: check gameService.getGameBySocketId to prevent multi-game — requires dependency injection to avoid circular import
  queue.push({ socketId, userId, nickname, joinedAt: Date.now(), botPrompted: false, socket });
  return true;
}

function dequeue(socketId) {
  const idx = queue.findIndex((q) => q.socketId === socketId);
  if (idx === -1) return null;
  return queue.splice(idx, 1)[0];
}

function acceptBots(socketId) {
  // 必须先经过 bot 补位提示，避免误调用将其他真人拉入 bot 局
  const me = queue.find((q) => q.socketId === socketId);
  if (!me) return null;
  if (me.botPrompted !== true) return null;
  // 仅把自己出队，不再 shift 其他真人
  dequeue(socketId);
  // 组队：本人 + bot 补足剩余座位
  const players = [me];
  for (let seat = players.length; seat < config.game.playersPerGame; seat++) {
    const bot = botService.makeBotPlayer(seat);
    players.push({
      socketId: null,
      userId: bot.userId,
      nickname: bot.nickname,
      isBot: true,
      socket: null,
    });
  }
  if (hooks.onMatchSuccess) {
    hooks.onMatchSuccess(players, true).catch((err) => {
      console.error('[matchService] onMatchSuccess (hybrid) 失败:', err);
    });
  }
  return players;
}

function declineBots(socketId) {
  const item = queue.find((q) => q.socketId === socketId);
  if (item) {
    item.joinedAt = Date.now();
    item.botPrompted = false;
  }
}

function cancel(socketId) {
  const removed = dequeue(socketId);
  if (removed && hooks.onRemoved) {
    hooks.onRemoved(socketId, 'cancelled');
  }
  return removed;
}

function getQueueLength() {
  return queue.length;
}

module.exports = {
  setHooks,
  start,
  stop,
  enqueue,
  dequeue,
  acceptBots,
  declineBots,
  cancel,
  getQueueLength,
};
