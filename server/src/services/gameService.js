const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const db = require('../db');
const llmService = require('./llmService');
const botService = require('./botService');

// 内存中的活跃对局
// gameId -> GameState
const activeGames = new Map();

/**
 * 创建对局（持久化 + 内存状态）
 * @param {object} puzzle - 题目
 * @param {Array} players - [{ socketId, userId, nickname, isBot }]
 * @returns {string} gameId
 */
function createGame(puzzle, players) {
  if (activeGames.size >= 200) return null;
  const gameId = uuidv4();
  const now = Date.now();

  // 写入 games 表
  db.prepare(`
    INSERT INTO games (id, puzzle_id, status, current_round, max_rounds, progress)
    VALUES (?, ?, 'playing', 1, ?, 0)
  `).run(gameId, puzzle.id, config.game.maxRounds);

  // 写入 game_players 表
  const seatStmt = db.prepare(`
    INSERT INTO game_players (game_id, user_id, nickname, is_bot, seat, questions_asked, score, stars, is_winner)
    VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)
  `);
  players.forEach((p, idx) => {
    seatStmt.run(gameId, p.userId, p.nickname, p.isBot ? 1 : 0, idx);
  });

  // 题目玩过次数 +1
  db.prepare(`UPDATE puzzles SET play_count = play_count + 1 WHERE id = ?`).run(puzzle.id);

  // 安全解析 tags（防止损坏的 JSON 导致对局创建失败）
  let puzzleTags = [];
  try { puzzleTags = puzzle.tags ? JSON.parse(puzzle.tags) : []; } catch (e) { puzzleTags = []; }

  // 内存状态
  const state = {
    id: gameId,
    puzzleId: puzzle.id,
    puzzle: {
      id: puzzle.id,
      title: puzzle.title,
      scenario: puzzle.scenario,
      truth: puzzle.truth,
      difficulty: puzzle.difficulty,
      tags: puzzleTags,
      playCount: (puzzle.play_count || 0) + 1,
    },
    players: players.map((p, idx) => ({
      userId: p.userId,
      nickname: p.nickname,
      isBot: !!p.isBot,
      seat: idx,
      socketId: p.socketId || null,
      questionsAsked: 0,
      score: 0,
      closeCount: 0,
    })),
    currentRound: 1,
    maxRounds: config.game.maxRounds,
    currentSeat: 0,
    status: 'playing',
    chat: [],
    stats: { yes: 0, no: 0, irrelevant: 0, total: 0 },
    progress: 0,
    closeStreak: 0,
    closeStreakRounds: new Set(),
    lastCloseSeat: null,
    timerInterval: null,
    turnTimer: null,
    timerRemaining: config.game.turnTimerSec,
    createdAt: now,
    botScheduleTimeout: null,
    currentTurnSubmitted: false,
  };

  activeGames.set(gameId, state);
  return gameId;
}

function getGame(gameId) {
  return activeGames.get(gameId);
}

function getGameBySocketId(socketId) {
  for (const [gameId, state] of activeGames) {
    if (state.players.find((p) => p.socketId === socketId)) return { gameId, state };
  }
  return null;
}

function pickRandomPuzzle() {
  const row = db.prepare(`
    SELECT * FROM puzzles WHERE status = 'online' ORDER BY RANDOM() LIMIT 1
  `).get();
  return row;
}

/**
 * 开始对局：下发 game:start，启动第一轮
 */
function startGame(gameId, io) {
  const state = getGame(gameId);
  if (!state) return;
  const room = `game:${gameId}`;
  // 给每个真人下发 game:start（包含自己的座位号）
  state.players.forEach((p) => {
    if (p.socketId) {
      io.to(p.socketId).emit('game:start', {
        gameId,
        puzzle: {
          id: state.puzzle.id,
          title: state.puzzle.title,
          scenario: state.puzzle.scenario,
          difficulty: state.puzzle.difficulty,
          tags: state.puzzle.tags,
          playCount: state.puzzle.playCount,
        },
        players: state.players.map((pl) => ({
          nickname: pl.nickname,
          seat: pl.seat,
          isBot: pl.isBot,
          questionsAsked: pl.questionsAsked,
        })),
        maxRounds: state.maxRounds,
        yourSeat: p.seat,
      });
    }
  });
  // 启动第一轮
  setTimeout(() => beginTurn(gameId, io), 500);
}

/**
 * 开始一轮：下发 game:turn，启动倒计时
 */
function beginTurn(gameId, io) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return;
  const room = `game:${gameId}`;
  const currentPlayer = state.players[state.currentSeat];
  state.currentTurnSubmitted = false;

  io.to(room).emit('game:turn', {
    round: state.currentRound,
    seat: state.currentSeat,
    nickname: currentPlayer.nickname,
    isBot: currentPlayer.isBot,
    timerSec: config.game.turnTimerSec,
  });

  // 倒计时
  state.timerRemaining = config.game.turnTimerSec;
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    state.timerRemaining -= 1;
    io.to(room).emit('game:timer', { remaining: state.timerRemaining });
    if (state.timerRemaining <= 0) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
      handleTurnTimeout(gameId, io);
    }
  }, 1000);

  // 如果是 bot，调度 bot 提问
  if (currentPlayer.isBot) {
    const thinkMs = botService.randomThinkMs();
    state.botScheduleTimeout = setTimeout(() => {
      handleBotTurn(gameId, io);
    }, thinkMs);
  }
}

/**
 * 处理 bot 提问
 */
async function handleBotTurn(gameId, io) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return;
  const player = state.players[state.currentSeat];
  if (!player || !player.isBot) return;

  // 构建 history 给 LLM
  const history = state.chat.map((c) => ({
    question: c.question,
    judgmentLabel: c.judgmentLabel,
  }));

  const question = await botService.generateQuestion(state.puzzle.scenario, history);
  if (!question) return;
  receiveQuestion(gameId, state.currentSeat, question, io, true);
}

/**
 * 接收玩家提问
 */
async function receiveQuestion(gameId, seat, question, io, isBot = false) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return { ok: false, error: '对局不存在或已结束' };
  if (seat !== state.currentSeat) return { ok: false, error: '当前不是你的回合' };
  if (state.timerInterval === null && !isBot) return { ok: false, error: '回合已结束' };
  if (state.currentTurnSubmitted) return { ok: false, error: '本回合已提交' };
  state.currentTurnSubmitted = true;

  const player = state.players[seat];
  // 清除倒计时与 bot 调度
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.botScheduleTimeout) {
    clearTimeout(state.botScheduleTimeout);
    state.botScheduleTimeout = null;
  }

  const room = `game:${gameId}`;
  // 1) 广播提问
  io.to(room).emit('game:question_posted', {
    round: state.currentRound,
    seat,
    nickname: player.nickname,
    question,
  });

  // 2) 调用 LLM 判定
  const history = state.chat.map((c) => ({
    question: c.question,
    judgmentLabel: c.judgmentLabel,
  }));
  const judgment = await llmService.judgeQuestion(
    state.puzzle.scenario,
    state.puzzle.truth,
    history,
    question,
    player.userId
  );

  // 3) 更新状态
  const chatEntry = {
    round: state.currentRound,
    seat,
    nickname: player.nickname,
    question,
    judgment: judgment.judgment,
    judgmentLabel: judgment.judgmentLabel,
    closeHint: judgment.closeToTruth,
  };
  if (state.chat.length > 500) state.chat.shift();
  state.chat.push(chatEntry);
  player.questionsAsked += 1;
  state.stats.total += 1;
  state.stats[judgment.judgment] += 1;
  player.score += 2;

  if (judgment.closeToTruth) {
    player.closeCount += 1;
    player.score += 10;
    state.closeStreak += 1;
    state.closeStreakRounds.add(state.currentRound);
    state.lastCloseSeat = seat;
  } else {
    state.closeStreak = 0;
    state.closeStreakRounds.clear();
  }

  // 4) 计算进度
  const closeTotal = state.players.reduce((s, p) => s + p.closeCount, 0);
  state.progress = Math.min(
    100,
    closeTotal * 20 + Math.floor((state.currentRound / state.maxRounds) * 30)
  );

  // 5) 写入 game_chat
  db.prepare(`
    INSERT INTO game_chat (game_id, round, seat, nickname, question, judgment, close_hint)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gameId, chatEntry.round, chatEntry.seat, chatEntry.nickname, chatEntry.question, chatEntry.judgment, chatEntry.closeHint ? 1 : 0);

  // 6) 广播判定
  io.to(room).emit('game:judgment', {
    round: state.currentRound,
    seat,
    nickname: player.nickname,
    question,
    judgment: judgment.judgment,
    judgmentLabel: judgment.judgmentLabel,
    closeHint: judgment.closeToTruth,
    progress: state.progress,
    stats: state.stats,
    ranking: getRanking(state),
  });

  // 7) 接近真相提示
  if (judgment.closeToTruth && state.progress >= 80) {
    io.to(room).emit('game:insight', { message: '有人在接近真相…' });
  }

  // 8) 检查揭晓条件
  // 安全约束：连续 close 需跨越至少 2 个不同轮次（closeStreakRounds），
  // 防止同一轮内多次 close 被重复计数而误触发提前揭晓；closeStreak 机制本身保留
  const shouldReveal =
    (state.closeStreak >= 2 && state.closeStreakRounds.size >= 2) ||
    state.currentRound >= state.maxRounds;
  if (shouldReveal) {
    revealGame(gameId, io);
    return { ok: true, revealed: true };
  }

  // 9) 下一轮
  nextTurn(gameId, io);
  return { ok: true };
}

function nextTurn(gameId, io) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return;
  state.currentSeat = (state.currentSeat + 1) % state.players.length;
  if (state.currentSeat === 0) {
    state.currentRound += 1;
    db.prepare(`UPDATE games SET current_round = ?, progress = ? WHERE id = ?`)
      .run(state.currentRound, state.progress, gameId);
  }
  setTimeout(() => beginTurn(gameId, io), 800);
}

function handleTurnTimeout(gameId, io) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return;
  const player = state.players[state.currentSeat];
  const room = `game:${gameId}`;
  io.to(room).emit('game:insight', {
    message: `${player.nickname} 未在规定时间内提问，跳过本轮`,
  });
  // bot 不应超时，但兜底
  if (player.isBot) {
    handleBotTurn(gameId, io);
    return;
  }
  nextTurn(gameId, io);
}

function getRanking(state) {
  return state.players
    .map((p) => ({ nickname: p.nickname, seat: p.seat, score: p.score, isBot: p.isBot }))
    .sort((a, b) => b.score - a.score);
}

/**
 * 揭晓对局
 */
function revealGame(gameId, io) {
  const state = getGame(gameId);
  if (!state || state.status !== 'playing') return;
  state.status = 'revealed';
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.botScheduleTimeout) {
    clearTimeout(state.botScheduleTimeout);
    state.botScheduleTimeout = null;
  }

  const room = `game:${gameId}`;
  // 计算胜者（最后触发 close 的玩家）
  let winnerSeat = state.lastCloseSeat;
  if (winnerSeat === null) {
    // 无人触发 close，选得分最高者
    const ranking = getRanking(state);
    if (ranking.length > 0 && ranking[0].score > 0) {
      winnerSeat = ranking[0].seat;
    }
  }

  // 计算星级与持久化
  const durationSec = Math.floor((Date.now() - state.createdAt) / 1000);
  const updatePlayerStmt = db.prepare(`
    UPDATE game_players SET questions_asked = ?, score = ?, stars = ?, is_winner = ?
    WHERE game_id = ? AND user_id = ?
  `);
  state.players.forEach((p) => {
    const stars = Math.max(1, Math.min(5, p.closeCount * 2 + Math.floor(p.questionsAsked / 2)));
    const isWinner = winnerSeat === p.seat ? 1 : 0;
    updatePlayerStmt.run(p.questionsAsked, p.score, stars, isWinner, gameId, p.userId);
    if (isWinner && !p.isBot) {
      // 更新用户统计
      db.prepare(`
        UPDATE users SET total_games = total_games + 1, wins = wins + 1, current_streak = current_streak + 1
        WHERE id = ?
      `).run(p.userId);
    } else if (!p.isBot) {
      db.prepare(`
        UPDATE users SET total_games = total_games + 1, current_streak = 0
        WHERE id = ?
      `).run(p.userId);
    }
  });

  // 更新 games 表
  const winnerUserId = winnerSeat !== null ? state.players[winnerSeat].userId : null;
  db.prepare(`
    UPDATE games SET status = 'revealed', current_round = ?, progress = ?,
    winner_user_id = ?, duration_sec = ?, ended_at = datetime('now')
    WHERE id = ?
  `).run(state.currentRound, state.progress, winnerUserId, durationSec, gameId);

  // 广播揭晓
  io.to(room).emit('game:reveal', {
    gameId,
    winner: winnerSeat !== null ? { seat: winnerSeat, nickname: state.players[winnerSeat].nickname } : null,
  });

  // 清理内存（延迟，给前端时间跳转）
  setTimeout(() => {
    activeGames.delete(gameId);
  }, 60000);
}

/**
 * 玩家离开对局
 */
function leaveGame(gameId, socketId, io) {
  const state = getGame(gameId);
  if (!state) return;
  const player = state.players.find((p) => p.socketId === socketId);
  if (!player) return;
  // 标记为断线（bot 接管？暂简单处理：跳过该玩家轮次）
  player.socketId = null;
  // 若当前是该玩家回合，跳过
  if (state.currentSeat === player.seat && state.status === 'playing') {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    io.to(`game:${gameId}`).emit('game:insight', {
      message: `${player.nickname} 已离开，跳过其回合`,
    });
    nextTurn(gameId, io);
  }
}

/**
 * 获取揭晓数据（供 REST API）
 */
function getRevealData(gameId) {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId);
  if (!game) return null;
  if (game.status !== 'revealed') return null;
  const puzzle = db.prepare(`SELECT * FROM puzzles WHERE id = ?`).get(game.puzzle_id);
  if (!puzzle) return null;
  const players = db.prepare(`
    SELECT * FROM game_players WHERE game_id = ? ORDER BY seat
  `).all(gameId);
  const chat = db.prepare(`
    SELECT * FROM game_chat WHERE game_id = ? ORDER BY id
  `).all(gameId);

  const winner = players.find((p) => p.is_winner);
  return {
    gameId,
    winner: winner ? { nickname: winner.nickname, seat: winner.seat } : null,
    truth: puzzle.truth,
    originalScenario: puzzle.scenario,
    puzzleTitle: puzzle.title,
    difficulty: puzzle.difficulty,
    playersStats: players.map((p) => ({
      nickname: p.nickname,
      seat: p.seat,
      isBot: !!p.is_bot,
      questionsCount: p.questions_asked,
      stars: p.stars,
      isWinner: !!p.is_winner,
    })),
    totalRounds: game.current_round,
    duration: game.duration_sec,
    chat: chat.map((c) => ({
      round: c.round,
      seat: c.seat,
      nickname: c.nickname,
      question: c.question,
      judgment: c.judgment,
      closeHint: !!c.close_hint,
    })),
  };
}

/**
 * 获取揭晓数据（带参与者鉴权，供 REST API）
 * 防止 IDOR：仅当对局已揭晓且调用者为该对局参与者时才返回真相数据。
 * @param {string} gameId
 * @param {string} userId
 * @returns {object|null}
 */
function getRevealDataForUser(gameId, userId) {
  const data = getRevealData(gameId);
  if (!data) return null;
  if (!userId) return null;
  const participant = db
    .prepare(`SELECT 1 FROM game_players WHERE game_id = ? AND user_id = ?`)
    .get(gameId, userId);
  if (!participant) return null;
  return data;
}

module.exports = {
  createGame,
  getGame,
  getGameBySocketId,
  pickRandomPuzzle,
  startGame,
  beginTurn,
  receiveQuestion,
  leaveGame,
  revealGame,
  getRevealData,
  getRevealDataForUser,
};
