require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'turtle-soup-dev-secret',
  jwtExpiresIn: '7d',
  adminJwtExpiresIn: '12h',

  zhipu: {
    apiKey: process.env.ZHIPU_API_KEY || '',
    model: process.env.ZHIPU_MODEL || 'glm-4-flash',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    timeoutMs: 8000,
  },

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:8080',

  game: {
    matchTimeoutSec: parseInt(process.env.MATCH_TIMEOUT_SEC || '30', 10),
    turnTimerSec: parseInt(process.env.TURN_TIMER_SEC || '15', 10),
    maxRounds: parseInt(process.env.MAX_ROUNDS || '10', 10),
    botThinkMinMs: parseInt(process.env.BOT_THINK_MIN_MS || '3000', 10),
    botThinkMaxMs: parseInt(process.env.BOT_THINK_MAX_MS || '6000', 10),
    playersPerGame: 3,
  },

  adminDefaultPassword: process.env.ADMIN_DEFAULT_PASSWORD || 'admin123',
};
