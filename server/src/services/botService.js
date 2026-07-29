const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const llmService = require('./llmService');

const BOT_NAME_POOL = ['推理达人', '逻辑大师', '海龟学徒', '谜题猎手', '侦探少女', '谜雾行者'];

function pickBotNames(count) {
  const pool = [...BOT_NAME_POOL];
  const result = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

function randomThinkMs() {
  const { botThinkMinMs, botThinkMaxMs } = config.game;
  return botThinkMinMs + Math.floor(Math.random() * (botThinkMaxMs - botThinkMinMs));
}

function makeBotPlayer(seat) {
  const name = BOT_NAME_POOL[seat % BOT_NAME_POOL.length];
  return {
    userId: ('b' + uuidv4()).slice(0, 36),
    nickname: name,
    isBot: true,
    seat,
  };
}

async function generateQuestion(scenario, history) {
  return llmService.generateBotQuestion(scenario, history);
}

module.exports = { pickBotNames, randomThinkMs, makeBotPlayer, generateQuestion, BOT_NAME_POOL };
