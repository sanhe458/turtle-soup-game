const express = require('express');
const gameService = require('../services/gameService');
const { verify } = require('../utils/jwt');
const router = express.Router();

function getUserId(token) {
  try { return verify(token).userId; } catch { return null; }
}

// GET /api/game/:id/state - 轮询游戏状态
router.get('/game/:id/state', (req, res) => {
  const state = gameService.getGame(req.params.id);
  if (!state) return res.status(404).json({ error: '对局不存在或已结束' });
  
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = getUserId(token);
  const player = state.players.find(p => p.userId === userId);
  if (!player) return res.status(403).json({ error: '你不在这场对局中' });

  res.json({
    gameId: state.id,
    status: state.status,
    currentRound: state.currentRound,
    maxRounds: state.maxRounds,
    currentSeat: state.currentSeat,
    yourSeat: player.seat,
    isYourTurn: state.currentSeat === player.seat,
    timerRemaining: state.timerRemaining || 0,
    puzzle: {
      id: state.puzzle.id, title: state.puzzle.title,
      scenario: state.puzzle.scenario, difficulty: state.puzzle.difficulty,
      tags: state.puzzle.tags,
    },
    players: state.players.map(p => ({
      nickname: p.nickname, seat: p.seat, isBot: p.isBot,
      questionsAsked: p.questionsAsked, score: p.score,
    })),
    chat: (state.chat || []).slice(-20).map(c => ({
      round: c.round, seat: c.seat, nickname: c.nickname,
      question: c.question, judgment: c.judgment, closeHint: c.closeHint,
    })),
  });
});

// POST /api/game/:id/question - 提交提问
router.post('/game/:id/question', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = getUserId(token);
  if (!userId) return res.status(401).json({ error: '请先登录' });

  const state = gameService.getGame(req.params.id);
  if (!state) return res.status(404).json({ error: '对局不存在' });

  const player = state.players.find(p => p.userId === userId);
  if (!player) return res.status(403).json({ error: '你不在这场对局中' });
  if (state.currentSeat !== player.seat) return res.status(400).json({ error: '不是你的回合' });

  const { question } = req.body || {};
  if (!question || question.trim().length === 0) return res.status(400).json({ error: '提问不能为空' });
  if (question.trim().length > 200) return res.status(400).json({ error: '提问过长（最多200字）' });

  // 使用 gameService 的判定逻辑（需要 io，但轮询不需要实时推送，传 null）
  const result = await gameService.receiveQuestion(req.params.id, player.seat, question.trim(), null, true);
  if (!result || !result.ok) return res.status(400).json({ error: result?.error || '提交失败' });
  res.json({ ok: true });
});

module.exports = router;
