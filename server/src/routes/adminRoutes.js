const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const redis = require('../redis');
const { signAdmin } = require('../utils/jwt');
const { adminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// 登录限流：每分钟 10 次
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' },
});

// 题目字段校验（仅校验已提供字段），返回错误描述或 null
function validatePuzzleFields({ title, scenario, truth, tags, judgeNote }) {
  if (title !== undefined) {
    if (typeof title !== 'string' || title.length < 1 || title.length > 64) {
      return '标题长度需为 1-64 个字符';
    }
  }
  if (scenario !== undefined) {
    if (typeof scenario !== 'string' || scenario.length < 1 || scenario.length > 2000) {
      return '汤面长度需为 1-2000 个字符';
    }
  }
  if (truth !== undefined) {
    if (typeof truth !== 'string' || truth.length < 1 || truth.length > 2000) {
      return '汤底长度需为 1-2000 个字符';
    }
  }
  if (judgeNote !== undefined && (typeof judgeNote !== 'string' || judgeNote.length > 2000)) return 'LLM 备注最长 2000 个字符';
  if (Array.isArray(tags)) {
    if (tags.length > 10) {
      return '标签最多 10 个';
    }
    for (const t of tags) {
      if (typeof t !== 'string' || t.length > 16) {
        return '每个标签需为字符串且长度不超过 16';
      }
    }
  }
  return null;
}

// POST /api/admin/login - 登录
router.post('/admin/login', loginLimiter, async (req, res) => {
  const { account, password } = req.body || {};
  if (!account || !password) {
    return res.status(400).json({ error: '账号和密码不能为空' });
  }
  const admin = await db.getOne(`SELECT * FROM admins WHERE account = ?`, [account]);
  if (!admin) {
    // 等时处理：执行一次无意义的 bcrypt 比较以抹平时序差异
    await bcrypt.compare(
      password,
      '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
    );
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const ok = await bcrypt.compare(password, admin.password_hash);
  if (!ok) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = signAdmin(admin.id, admin.account, admin.name, admin.role, admin.token_version);
  res.cookie("admin_token", token, { httpOnly: true, sameSite: "lax", path: "/soup", maxAge: 15 * 60 * 1000 });
  res.json({
    token,
    admin: { name: admin.name, role: admin.role, email: admin.email },
  });
});

// POST /api/admin/logout - 退出登录（通过递增 token_version 吊销当前 token）
router.post('/admin/logout', adminAuth, async (req, res) => {
  await db.run('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [req.admin.id]);
  // 主动失效缓存，确保旧 token 立即不可用（不必等 TTL 兜底）
  await redis.del(`auth:a:${req.admin.id}`);
  res.json({ ok: true });
});

// GET /api/admin/dashboard - 总览 KPI
router.get('/admin/dashboard', adminAuth, async (req, res) => {
  const range = req.query.range || 'today'; // today / week / month

  // KPI
  const totalUsers = (await db.getOne(`SELECT COUNT(*) as c FROM users`)).c;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayGames = (await db.getOne(`
    SELECT COUNT(*) as c FROM games WHERE ended_at >= ? AND status = 'revealed'
  `, [todayStart])).c;
  const totalPuzzles = (await db.getOne(`SELECT COUNT(*) as c FROM puzzles`)).c;
  const activePuzzles = (await db.getOne(`SELECT COUNT(*) as c FROM puzzles WHERE status = 'online'`)).c;

  // 用户增长（最近 7 天）
  const userGrowth = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const newUsers = (await db.getOne(`
      SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ?
    `, [d, next])).c;
    const activeUsers = (await db.getOne(`
      SELECT COUNT(DISTINCT gp.user_id) as c
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE g.ended_at >= ? AND g.ended_at < ? AND gp.is_bot = 0
    `, [d, next])).c;
    userGrowth.push({
      date: d.toISOString().slice(0, 10),
      label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
      newUsers,
      activeUsers,
    });
  }

  // 最近对局
  const recentGamesRows = await db.query(`
    SELECT g.id, g.ended_at, g.current_round, g.winner_user_id, p.title as puzzle_title,
      (SELECT GROUP_CONCAT(nickname SEPARATOR ', ') FROM game_players WHERE game_id = g.id AND is_bot = 0) as player
    FROM games g
    JOIN puzzles p ON p.id = g.puzzle_id
    WHERE g.status = 'revealed'
    ORDER BY g.ended_at DESC
    LIMIT 5
  `);
  const recentGames = recentGamesRows.map((r) => ({
    gameId: r.id,
    player: r.player || '—',
    puzzle: r.puzzle_title,
    rounds: r.current_round,
    result: r.winner_user_id ? '胜利' : '失败',
    time: r.ended_at,
  }));

  // 难度分布
  const distRows = await db.query(`
    SELECT difficulty, COUNT(*) as c FROM puzzles WHERE status = 'online' GROUP BY difficulty
  `);
  const difficultyDist = { easy: 0, medium: 0, hard: 0 };
  distRows.forEach((r) => {
    if (difficultyDist.hasOwnProperty(r.difficulty)) difficultyDist[r.difficulty] = r.c;
  });
  const totalDist = difficultyDist.easy + difficultyDist.medium + difficultyDist.hard;

  // 热门题目 Top 5
  const hotPuzzles = (await db.query(`
    SELECT title, play_count FROM puzzles WHERE status = 'online'
    ORDER BY play_count DESC LIMIT 5
  `)).map((r, i) => ({ rank: i + 1, title: r.title, playCount: r.play_count }));

  // 待办事项
  const pendingPuzzles = (await db.getOne(`
    SELECT COUNT(*) as c FROM puzzles WHERE status = 'pending'
  `)).c;
  const pendingTasks = [];
  if (pendingPuzzles > 0) {
    pendingTasks.push({
      type: 'puzzle_review',
      count: pendingPuzzles,
      detail: `${pendingPuzzles} 道新题待审核`,
      urgency: 'normal',
    });
  }
  pendingTasks.push({
    type: 'system',
    count: 1,
    detail: 'AI 模型版本可更新 (v2.1.0)',
    urgency: 'normal',
  });

  res.json({
    kpi: {
      totalUsers,
      todayGames,
      activePuzzles,
      totalPuzzles,
      aiAccuracy: 0.972, // 静态占位
    },
    userGrowth,
    recentGames,
    difficultyDist: {
      easy: totalDist > 0 ? Math.round((difficultyDist.easy / totalDist) * 100) : 0,
      medium: totalDist > 0 ? Math.round((difficultyDist.medium / totalDist) * 100) : 0,
      hard: totalDist > 0 ? Math.round((difficultyDist.hard / totalDist) * 100) : 0,
      total: totalDist,
    },
    hotPuzzles,
    pendingTasks,
    range,
  });
});

// GET /api/admin/puzzles - 题库列表
router.get('/admin/puzzles', adminAuth, async (req, res) => {
  const { difficulty, status, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || '10', 10)));
  const offset = (page - 1) * limit;

  let where = ['1=1'];
  const params = [];
  if (difficulty && difficulty !== 'all') {
    where.push('difficulty = ?');
    params.push(difficulty);
  }
  if (status && status !== 'all') {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(title LIKE ? OR scenario LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereSql = where.join(' AND ');

  const total = (await db.getOne(`SELECT COUNT(*) as c FROM puzzles WHERE ${whereSql}`, params)).c;
  const items = await db.query(`
    SELECT * FROM puzzles WHERE ${whereSql}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  res.json({
    items: items.map((r) => ({
      id: r.id,
      title: r.title,
      scenario: r.scenario,
      truth: r.truth,
      difficulty: r.difficulty,
      status: r.status,
      tags: r.tags ? JSON.parse(r.tags) : [],
      playCount: r.play_count,
      rating: r.rating,
      createdAt: r.created_at,
    })),
    total,
    page,
    limit,
  });
});

// POST /api/admin/puzzles - 新建题目
router.post('/admin/puzzles', adminAuth, async (req, res) => {
  const { title, scenario, truth, difficulty, tags, judgeNote } = req.body || {};
  if (!title || !scenario || !truth || !difficulty) {
    return res.status(400).json({ error: '标题、汤面、汤底、难度均为必填' });
  }
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: '难度必须为 easy / medium / hard' });
  }
  const fieldErr = validatePuzzleFields({ title, scenario, truth, tags, judgeNote });
  if (fieldErr) return res.status(400).json({ error: fieldErr });
  const id = uuidv4();
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : '[]';
  await db.run(`
    INSERT INTO puzzles (id, title, scenario, truth, difficulty, status, tags, judge_note)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `, [id, title, scenario, truth, difficulty, tagsJson, judgeNote || null]);
  const row = await db.getOne(`SELECT * FROM puzzles WHERE id = ?`, [id]);
  res.json({
    puzzle: {
      ...row,
      tags: row.tags ? JSON.parse(row.tags) : [],
      playCount: row.play_count,
      createdAt: row.created_at,
    },
  });
});

// PUT /api/admin/puzzles/:id - 编辑题目
router.put('/admin/puzzles/:id', adminAuth, async (req, res) => {
  const { title, scenario, truth, difficulty, tags, judgeNote } = req.body || {};
  const existing = await db.getOne(`SELECT * FROM puzzles WHERE id = ?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: '题目不存在' });
  const fieldErr = validatePuzzleFields({ title, scenario, truth, tags, judgeNote });
  if (fieldErr) return res.status(400).json({ error: fieldErr });
  const newData = {
    title: title ?? existing.title,
    scenario: scenario ?? existing.scenario,
    truth: truth ?? existing.truth,
    difficulty: difficulty ?? existing.difficulty,
    tags: Array.isArray(tags) ? JSON.stringify(tags) : existing.tags,
    judge_note: judgeNote !== undefined ? judgeNote : existing.judge_note,
  };
  if (newData.difficulty && !['easy', 'medium', 'hard'].includes(newData.difficulty)) {
    return res.status(400).json({ error: '难度必须为 easy / medium / hard' });
  }
  await db.run(`
    UPDATE puzzles SET title = ?, scenario = ?, truth = ?, difficulty = ?, tags = ?, judge_note = ?
    WHERE id = ?
  `, [newData.title, newData.scenario, newData.truth, newData.difficulty, newData.tags, newData.judge_note, req.params.id]);
  const row = await db.getOne(`SELECT * FROM puzzles WHERE id = ?`, [req.params.id]);
  res.json({
    puzzle: {
      ...row,
      tags: row.tags ? JSON.parse(row.tags) : [],
      playCount: row.play_count,
      createdAt: row.created_at,
    },
  });
});

// PATCH /api/admin/puzzles/:id/status - 改状态
router.patch('/admin/puzzles/:id/status', adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['online', 'pending', 'offline'].includes(status)) {
    return res.status(400).json({ error: '状态必须为 online / pending / offline' });
  }
  const existing = await db.getOne(`SELECT * FROM puzzles WHERE id = ?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: '题目不存在' });
  await db.run(`UPDATE puzzles SET status = ? WHERE id = ?`, [status, req.params.id]);
  const row = await db.getOne(`SELECT * FROM puzzles WHERE id = ?`, [req.params.id]);
  res.json({
    puzzle: {
      ...row,
      tags: row.tags ? JSON.parse(row.tags) : [],
      playCount: row.play_count,
      createdAt: row.created_at,
    },
  });
});

module.exports = router;
