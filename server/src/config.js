require('dotenv').config();

// 启动校验：JWT_SECRET 必须设置且长度 >= 32
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  console.error('JWT_SECRET 必须设置且长度>=32');
  process.exit(1);
}

// 启动校验：管理员默认口令必须设置且不能使用弱口令
const adminDefaultPassword = process.env.ADMIN_DEFAULT_PASSWORD;
const WEAK_PASSWORDS = ['admin123', 'admin', 'password', '123456', 'admin@123', '12345678'];
if (!adminDefaultPassword || WEAK_PASSWORDS.includes(adminDefaultPassword)) {
  console.error('管理员默认口令过弱，请设置强口令');
  process.exit(1);
}

// API Key 加密所需 KEK：API_KEY_ENCRYPTION_KEY 必须设置且长度 >= 16，用于 AES-256-GCM 加密落库的供应商 API Key。
// 此处不强制退出（避免破坏未配置该变量的开发环境）；缺失时 crypto.js 的 getKey() 会在实际加解密时抛错。
if (!process.env.API_KEY_ENCRYPTION_KEY || process.env.API_KEY_ENCRYPTION_KEY.length < 16) {
  console.warn('API_KEY_ENCRYPTION_KEY 未设置或长度 < 16，API Key 加密功能将不可用');
}

// 启动校验：MySQL 凭据必须设置
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
if (!dbUser || !dbPassword) {
  console.error('DB_USER 与 DB_PASSWORD 必须设置（MySQL 5.7 连接凭据）');
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h',
  adminJwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '15m',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:8080',

  game: {
    matchTimeoutSec: parseInt(process.env.MATCH_TIMEOUT_SEC || '30', 10),
    turnTimerSec: parseInt(process.env.TURN_TIMER_SEC || '15', 10),
    maxRounds: parseInt(process.env.MAX_ROUNDS || '10', 10),
    botThinkMinMs: parseInt(process.env.BOT_THINK_MIN_MS || '3000', 10),
    botThinkMaxMs: parseInt(process.env.BOT_THINK_MAX_MS || '6000', 10),
    playersPerGame: 3,
  },

  adminDefaultPassword,

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: dbUser,
    password: dbPassword,
    database: process.env.DB_DATABASE || 'turtle_soup',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  },
};
