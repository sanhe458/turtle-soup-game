const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { signUser } = require('../utils/jwt');
const { userAuth } = require('../middleware/userAuth');
const gameService = require('../services/gameService');

const router = express.Router();

// 注册限流：每分钟 10 次
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '注册请求过于频繁，请稍后再试' },
});

// POST /api/users/register - 提交昵称获取身份
router.post('/users/register', registerLimiter, (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return res.status(400).json({ error: '昵称不能为空' });
  }
  const trimmed = nickname.trim();
  // 昵称白名单：中文、字母、数字、下划线、连字符，长度 1-16
  if (!/^[\u4e00-\u9fa5a-zA-Z0-9_\-]{1,16}$/.test(trimmed)) {
    return res.status(400).json({ error: '昵称仅支持中文、字母、数字、下划线与连字符，长度 1-16' });
  }
  const userId = uuidv4();
  const avatarSeed = userId.slice(0, 8);
  db.prepare(`
    INSERT INTO users (id, nickname, avatar_seed) VALUES (?, ?, ?)
  `).run(userId, trimmed, avatarSeed);
  // 新建用户 token_version 默认为 0
  const token = signUser(userId, trimmed, 0);
  res.json({ userId, nickname: trimmed, token });
});

// POST /api/users/logout - 退出登录（通过递增 token_version 吊销当前 token）
router.post('/users/logout', userAuth, (req, res) => {
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.userId);
  res.json({ ok: true });
});

// GET /api/user/profile - 个人统计
router.get('/user/profile', userAuth, (req, res) => {
  const row = db.prepare(`
    SELECT total_games, wins, current_streak, created_at FROM users WHERE id = ?
  `).get(req.user.userId);
  if (!row) return res.status(404).json({ error: '用户不存在' });

  // 今日场次
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayGames = db.prepare(`
    SELECT COUNT(*) as c FROM games g
    JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.user_id = ? AND g.ended_at >= ?
  `).get(req.user.userId, todayStart.toISOString());
  const totalGames = row.total_games || 0;
  const wins = row.wins || 0;
  const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) / 100 : 0;

  res.json({
    todayGames: todayGames?.c || 0,
    winRate,
    streak: row.current_streak || 0,
    totalGames,
  });
});

// GET /api/user/recent-games - 最近对局
router.get('/user/recent-games', userAuth, (req, res) => {
  const games = db.prepare(`
    SELECT g.id, g.ended_at, g.puzzle_id, gp.is_winner, gp2.nickname
    FROM games g
    JOIN game_players gp ON gp.game_id = g.id AND gp.user_id = ?
    LEFT JOIN game_players gp2 ON gp2.game_id = g.id AND gp2.user_id != ?
    WHERE g.status = 'revealed'
    ORDER BY g.ended_at DESC
    LIMIT 10
  `).all(req.user.userId, req.user.userId);

  // 聚合对手
  const result = games.map((g) => {
    const opponents = games
      .filter((x) => x.id === g.id && x.nickname !== req.user.nickname)
      .map((x) => x.nickname);
    return {
      gameId: g.id,
      opponents: opponents.slice(0, 2),
      result: g.is_winner ? '胜利' : '失败',
      timeAgo: g.ended_at,
    };
  });
  // 去重（一个 game 可能有多行因 LEFT JOIN）
  const seen = new Set();
  const deduped = [];
  for (const item of result) {
    if (seen.has(item.gameId)) continue;
    seen.add(item.gameId);
    deduped.push(item);
  }
  res.json(deduped);
});

// GET /api/game/:id/reveal - 揭晓数据（仅参与者可读，防止 IDOR）
router.get('/game/:id/reveal', userAuth, (req, res) => {
  const data = gameService.getRevealDataForUser(req.params.id, req.user.userId);
  if (!data) return res.status(403).json({ error: '对局不存在、未揭晓或您非参与者' });
  res.json(data);
});

module.exports = router;
