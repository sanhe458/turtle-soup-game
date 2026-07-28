const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
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
function validatePuzzleFields({ title, scenario, truth, tags }) {
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
  const admin = db.prepare(`SELECT * FROM admins WHERE account = ?`).get(account);
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
  res.json({
    token,
    admin: { name: admin.name, role: admin.role, email: admin.email },
  });
});

// POST /api/admin/logout - 退出登录（通过递增 token_version 吊销当前 token）
router.post('/admin/logout', adminAuth, (req, res) => {
  db.prepare('UPDATE admins SET token_version = token_version + 1 WHERE id = ?').run(req.admin.id);
  res.json({ ok: true });
});

// GET /api/admin/dashboard - 总览 KPI
router.get('/admin/dashboard', adminAuth, (req, res) => {
  const range = req.query.range || 'today'; // today / week / month

  // KPI
  const totalUsers = db.prepare(`SELECT COUNT(*) as c FROM users`).get().c;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayGames = db.prepare(`
    SELECT COUNT(*) as c FROM games WHERE ended_at >= ? AND status = 'revealed'
  `).get(todayStart.toISOString()).c;
  const totalPuzzles = db.prepare(`SELECT COUNT(*) as c FROM puzzles`).get().c;
  const activePuzzles = db.prepare(`SELECT COUNT(*) as c FROM puzzles WHERE status = 'online'`).get().c;

  // 用户增长（最近 7 天）
  const userGrowth = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const newUsers = db.prepare(`
      SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ?
    `).get(d.toISOString(), next.toISOString()).c;
    const activeUsers = db.prepare(`
      SELECT COUNT(DISTINCT gp.user_id) as c
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE g.ended_at >= ? AND g.ended_at < ? AND gp.is_bot = 0
    `).get(d.toISOString(), next.toISOString()).c;
    userGrowth.push({
      date: d.toISOString().slice(0, 10),
      label: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
      newUsers,
      activeUsers,
    });
  }

  // 最近对局
  const recentGamesRows = db.prepare(`
    SELECT g.id, g.ended_at, g.current_round, g.winner_user_id, p.title as puzzle_title,
      (SELECT GROUP_CONCAT(nickname, ', ') FROM game_players WHERE game_id = g.id AND is_bot = 0 LIMIT 1) as player
    FROM games g
    JOIN puzzles p ON p.id = g.puzzle_id
    WHERE g.status = 'revealed'
    ORDER BY g.ended_at DESC
    LIMIT 5
  `).all();
  const recentGames = recentGamesRows.map((r) => ({
    gameId: r.id,
    player: r.player || '—',
    puzzle: r.puzzle_title,
    rounds: r.current_round,
    result: r.winner_user_id ? '胜利' : '失败',
    time: r.ended_at,
  }));

  // 难度分布
  const distRows = db.prepare(`
    SELECT difficulty, COUNT(*) as c FROM puzzles WHERE status = 'online' GROUP BY difficulty
  `).all();
  const difficultyDist = { easy: 0, medium: 0, hard: 0 };
  distRows.forEach((r) => {
    if (difficultyDist.hasOwnProperty(r.difficulty)) difficultyDist[r.difficulty] = r.c;
  });
  const totalDist = difficultyDist.easy + difficultyDist.medium + difficultyDist.hard;

  // 热门题目 Top 5
  const hotPuzzles = db.prepare(`
    SELECT title, play_count FROM puzzles WHERE status = 'online'
    ORDER BY play_count DESC LIMIT 5
  `).all().map((r, i) => ({ rank: i + 1, title: r.title, playCount: r.play_count }));

  // 待办事项
  const pendingPuzzles = db.prepare(`
    SELECT COUNT(*) as c FROM puzzles WHERE status = 'pending'
  `).get().c;
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
router.get('/admin/puzzles', adminAuth, (req, res) => {
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

  const total = db.prepare(`SELECT COUNT(*) as c FROM puzzles WHERE ${whereSql}`).get(...params).c;
  const items = db.prepare(`
    SELECT * FROM puzzles WHERE ${whereSql}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

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
router.post('/admin/puzzles', adminAuth, (req, res) => {
  const { title, scenario, truth, difficulty, tags } = req.body || {};
  if (!title || !scenario || !truth || !difficulty) {
    return res.status(400).json({ error: '标题、汤面、汤底、难度均为必填' });
  }
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: '难度必须为 easy / medium / hard' });
  }
  const fieldErr = validatePuzzleFields({ title, scenario, truth, tags });
  if (fieldErr) return res.status(400).json({ error: fieldErr });
  const id = uuidv4();
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : '[]';
  db.prepare(`
    INSERT INTO puzzles (id, title, scenario, truth, difficulty, status, tags)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, title, scenario, truth, difficulty, tagsJson);
  const row = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(id);
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
router.put('/admin/puzzles/:id', adminAuth, (req, res) => {
  const { title, scenario, truth, difficulty, tags } = req.body || {};
  const existing = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '题目不存在' });
  const fieldErr = validatePuzzleFields({ title, scenario, truth, tags });
  if (fieldErr) return res.status(400).json({ error: fieldErr });
  const newData = {
    title: title ?? existing.title,
    scenario: scenario ?? existing.scenario,
    truth: truth ?? existing.truth,
    difficulty: difficulty ?? existing.difficulty,
    tags: Array.isArray(tags) ? JSON.stringify(tags) : existing.tags,
  };
  if (newData.difficulty && !['easy', 'medium', 'hard'].includes(newData.difficulty)) {
    return res.status(400).json({ error: '难度必须为 easy / medium / hard' });
  }
  db.prepare(`
    UPDATE puzzles SET title = ?, scenario = ?, truth = ?, difficulty = ?, tags = ?
    WHERE id = ?
  `).run(newData.title, newData.scenario, newData.truth, newData.difficulty, newData.tags, req.params.id);
  const row = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(req.params.id);
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
router.patch('/admin/puzzles/:id/status', adminAuth, (req, res) => {
  const { status } = req.body || {};
  if (!['online', 'pending', 'offline'].includes(status)) {
    return res.status(400).json({ error: '状态必须为 online / pending / offline' });
  }
  const existing = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '题目不存在' });
  db.prepare(`UPDATE puzzles SET status = ? WHERE id = ?`).run(status, req.params.id);
  const row = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(req.params.id);
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
