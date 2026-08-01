const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const redis = require('../redis');
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
router.post('/users/register', registerLimiter, async (req, res) => {
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
  try {
    await db.run(`
      INSERT INTO users (id, nickname, avatar_seed) VALUES (?, ?, ?)
    `, [userId, trimmed, avatarSeed]);
  } catch (err) {
    // 并发重复注册等场景：同一昵称撞唯一约束时返回友好错误
    console.error('[userRoutes] register 失败:', err.message);
    return res.status(500).json({ error: '注册失败，请稍后再试' });
  }
  // 新建用户 token_version 默认为 0
  const token = signUser(userId, trimmed, 0);
  res.json({ userId, nickname: trimmed, token });
});

// POST /api/users/logout - 退出登录（通过递增 token_version 吊销当前 token）
router.post('/users/logout', userAuth, async (req, res) => {
  await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.userId]);
  // 主动失效缓存，确保旧 token 立即不可用（不必等 TTL 兜底）
  await redis.del(`auth:u:${req.user.userId}`);
  res.json({ ok: true });
});

// GET /api/user/profile - 个人统计
router.get('/user/profile', userAuth, async (req, res) => {
  const row = await db.getOne(`
    SELECT total_games, wins, current_streak, created_at FROM users WHERE id = ?
  `, [req.user.userId]);
  if (!row) return res.status(404).json({ error: '用户不存在' });

  // 今日场次
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayGames = await db.getOne(`
    SELECT COUNT(*) as c FROM games g
    JOIN game_players gp ON gp.game_id = g.id
    WHERE gp.user_id = ? AND g.ended_at >= ?
  `, [req.user.userId, todayStart]);
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
router.get('/user/recent-games', userAuth, async (req, res) => {
  const games = await db.query(`
    SELECT g.id, g.ended_at, g.puzzle_id, gp.is_winner, gp2.nickname
    FROM games g
    JOIN game_players gp ON gp.game_id = g.id AND gp.user_id = ?
    LEFT JOIN game_players gp2 ON gp2.game_id = g.id AND gp2.user_id != ?
    WHERE g.status = 'revealed'
    ORDER BY g.ended_at DESC
    LIMIT 10
  `, [req.user.userId, req.user.userId]);

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
router.get('/game/:id/reveal', userAuth, async (req, res) => {
  const data = await gameService.getRevealDataForUser(req.params.id, req.user.userId);
  if (!data) return res.status(403).json({ error: '对局不存在、未揭晓或您非参与者' });
  res.json(data);
});

module.exports = router;
