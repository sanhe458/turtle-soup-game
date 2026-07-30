const express = require('express');
const gameService = require('../services/gameService');
const llmService = require('../services/llmService');
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

// POST /api/game/:id/assess - 主动评估进度（每人每轮限一次）
router.post('/game/:id/assess', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = getUserId(token);
  if (!userId) return res.status(401).json({ error: '请先登录' });

  const state = gameService.getGame(req.params.id);
  if (!state) return res.status(404).json({ error: '对局不存在或已结束' });

  const player = state.players.find(p => p.userId === userId);
  if (!player) return res.status(403).json({ error: '你不在这场对局中' });
  if (state.status !== 'playing') return res.status(400).json({ error: '对局已结束' });

  // 每人每轮限一次
  const key = `${userId}:${state.currentRound}`;
  if (state.assessUsed && state.assessUsed.has(key)) {
    return res.status(429).json({ error: '本轮已评估过，请下轮再试' });
  }
  if (!state.assessUsed) state.assessUsed = new Set();
  state.assessUsed.add(key);

  const history = state.chat.map(c => ({
    question: c.question,
    judgmentLabel: c.judgmentLabel,
  }));

  const result = await llmService.assessProgress(
    state.puzzle.scenario,
    state.puzzle.truth,
    history,
    state.puzzle.judgeNote
  );

  const assessment = result.assessment;

  // 如果评估为 spotted_the_truth，直接揭晓，该玩家获胜
  if (assessment === 'spotted_the_truth') {
    // 记录该玩家为最终胜者
    state.lastCloseSeat = player.seat;
    // 执行揭晓
    // 注意：revealGame 需要 io，轮询模式传 null
    await gameService.revealGame(req.params.id, null);
    return res.json({
      assessment,
      message: '太棒了！你已经掌握了真相的关键！游戏揭晓！',
      revealed: true,
    });
  }

  const messages = {
    nowhere_near: '目前还完全没有触及到核心，继续推理吧',
    getting_closer: '方向对了，但离核心真相还有一段距离',
  };

  res.json({ assessment, message: messages[assessment] || '继续推理吧', revealed: false });
});

module.exports = router;
