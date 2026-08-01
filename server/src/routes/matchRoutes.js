const express = require('express');
const matchService = require('../services/matchService');
const gameService = require('../services/gameService');
const { verify } = require('../utils/jwt');
const { socketUserMap } = require('../sockets/matchSocket');

const router = express.Router();

// 轮询用的玩家状态表（替代 socketUserMap）
const pollingPlayers = new Map(); // token -> { userId, nickname, gameId, seat, matchStatus, joinedAt, botPrompted }

function getPlayer(token) {
  if (!token) return null;
  try {
    const decoded = verify(token);
    if (decoded.type !== 'user') return null;
    return { userId: decoded.userId, nickname: decoded.nickname };
  } catch { return null; }
}

// GET /api/match/resume - 查询是否有可重回的进行中对局（意外退出后回首页用）
router.get('/match/resume', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (!player) return res.status(401).json({ error: '请先输入昵称' });

  const entry = pollingPlayers.get(player.userId);
  if (!entry || !entry.gameId) {
    return res.json({ hasActiveGame: false });
  }

  const game = gameService.getGame(entry.gameId);
  if (game && game.status === 'playing') {
    return res.json({ hasActiveGame: true, gameId: entry.gameId, yourSeat: entry.seat });
  }

  // 游戏已结束，清理旧记录，避免残留
  pollingPlayers.delete(player.userId);
  return res.json({ hasActiveGame: false });
});

// POST /api/match/join - 加入匹配队列
router.post('/match/join', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (!player) return res.status(401).json({ error: '请先输入昵称' });

  if (pollingPlayers.has(player.userId)) {
    const existing = pollingPlayers.get(player.userId);
    if (existing.gameId) {
      // 检查游戏是否真的还在进行中，防止结束后的死循环
      const game = gameService.getGame(existing.gameId);
      if (game && game.status === 'playing') {
        return res.json({ status: 'matched', gameId: existing.gameId, yourSeat: existing.seat });
      }
      // 游戏已结束，清除旧记录，重新匹配
      pollingPlayers.delete(player.userId);
    } else {
      return res.json({ status: existing.matchStatus || 'waiting' });
    }
  }

  pollingPlayers.set(player.userId, {
    ...player,
    matchStatus: 'waiting',
    joinedAt: Date.now(),
    botPrompted: false,
  });

  res.json({ status: 'waiting', message: '已加入匹配队列' });
});

// GET /api/match/status - 轮询匹配状态
router.get('/match/status', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (!player) return res.status(401).json({ error: '请先输入昵称' });

  const entry = pollingPlayers.get(player.userId);
  if (!entry) return res.json({ status: 'idle' });

  // 已匹配成功
  if (entry.gameId) {
    // 游戏可能已结束（activeGames 已清理），此时应清除旧记录返回 idle，避免死循环
    const game = gameService.getGame(entry.gameId);
    if (game && game.status === 'playing') {
      return res.json({ status: 'matched', gameId: entry.gameId, yourSeat: entry.seat });
    }
    pollingPlayers.delete(player.userId);
    return res.json({ status: 'idle' });
  }

  const waitedSec = Math.floor((Date.now() - entry.joinedAt) / 1000);

  // 30 秒到了，提示补位
  if (waitedSec >= 30 && !entry.botPrompted) {
    entry.botPrompted = true;
    return res.json({ status: 'prompted', waitedSec, message: '30 秒未匹配到足够真人，是否接受 AI 机器人补位？' });
  }

  res.json({
    status: entry.botPrompted ? 'prompted' : 'waiting',
    waitedSec,
  });
});

// POST /api/match/accept-bots - 接受 AI 补位
router.post('/match/accept-bots', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (!player) return res.status(401).json({ error: '请先输入昵称' });

  const entry = pollingPlayers.get(player.userId);
  if (!entry || (!entry.botPrompted && (Date.now() - entry.joinedAt) < 30000)) {
    return res.status(400).json({ error: '尚未到补位时机' });
  }

  // 创建 AI 对局
  const puzzle = await gameService.pickRandomPuzzle();
  if (!puzzle) return res.status(500).json({ error: '暂无可用题目' });

  const { makeBotPlayer } = require('../services/botService');
  const qItem = { userId: player.userId, nickname: player.nickname, socketId: null };
  const players = [qItem];
  for (let seat = 1; seat < 3; seat++) {
    const bot = makeBotPlayer(seat);
    players.push({ userId: bot.userId, nickname: bot.nickname, isBot: true, socketId: null, socket: null });
  }

  const gameId = await gameService.createGame(puzzle, players);
  if (!gameId) return res.status(500).json({ error: '创建对局失败' });

  entry.gameId = gameId;
  entry.seat = 0;
  gameService.startGame(gameId, null);
  entry.matchStatus = 'matched';

  // 不用 socket 了，直接返回
  res.json({
    status: 'matched',
    gameId,
    yourSeat: 0,
    puzzle: { title: puzzle.title, difficulty: puzzle.difficulty },
    players: [
      { nickname: player.nickname, isBot: false },
      { nickname: players[1].nickname, isBot: true },
      { nickname: players[2].nickname, isBot: true },
    ],
  });
});

// POST /api/match/decline-bots - 拒绝补位，继续等
router.post('/match/decline-bots', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (!player) return res.status(401).json({ error: '请先输入昵称' });

  const entry = pollingPlayers.get(player.userId);
  if (entry) {
    entry.joinedAt = Date.now();
    entry.botPrompted = false;
  }
  res.json({ status: 'waiting' });
});

// GET /api/match/queue-size - 当前匹配队列人数（公开，无需登录）
router.get('/match/queue-size', (req, res) => {
  // 只统计状态为 waiting/prompted 的玩家
  let count = 0;
  for (const [_, entry] of pollingPlayers) {
    if (!entry.gameId && entry.matchStatus !== 'matched') count++;
  }
  res.json({ queueSize: count });
});

// POST /api/match/cancel - 取消匹配
router.post('/match/cancel', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const player = getPlayer(token);
  if (player) pollingPlayers.delete(player.userId);
  res.json({ ok: true });
});

module.exports = router;
