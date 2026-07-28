const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/puzzles/:id - 题目详情（仅汤面，不含汤底）
router.get('/puzzles/:id', async (req, res) => {
  const row = await db.getOne(`
    SELECT id, title, scenario, difficulty, tags, play_count, rating FROM puzzles
    WHERE id = ? AND status = 'online'
  `, [req.params.id]);
  if (!row) return res.status(404).json({ error: '题目不存在或已下架' });
  res.json({
    id: row.id,
    title: row.title,
    scenario: row.scenario,
    difficulty: row.difficulty,
    tags: row.tags ? JSON.parse(row.tags) : [],
    playCount: row.play_count,
    rating: row.rating,
  });
});

module.exports = router;
