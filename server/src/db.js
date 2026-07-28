const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  charset: 'utf8mb4',
  timezone: '+00:00',
  dateStrings: false,
});

// 便捷封装：? 占位符行为与 better-sqlite3 一致
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}
async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}
async function run(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result; // { affectedRows, insertId, ... }
}
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) NOT NULL PRIMARY KEY,
    nickname VARCHAR(64) NOT NULL,
    avatar_seed VARCHAR(64),
    total_games INT DEFAULT 0,
    wins INT DEFAULT 0,
    current_streak INT DEFAULT 0,
    token_version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS puzzles (
    id CHAR(36) NOT NULL PRIMARY KEY,
    title VARCHAR(128) NOT NULL,
    scenario TEXT NOT NULL,
    truth TEXT NOT NULL,
    difficulty VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'online',
    tags TEXT,
    play_count INT DEFAULT 0,
    rating INT DEFAULT 90,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS games (
    id CHAR(36) NOT NULL PRIMARY KEY,
    puzzle_id CHAR(36) NOT NULL,
    status VARCHAR(32) NOT NULL,
    current_round INT DEFAULT 1,
    max_rounds INT DEFAULT 10,
    progress INT DEFAULT 0,
    winner_user_id CHAR(36),
    duration_sec INT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME NULL,
    CONSTRAINT fk_games_puzzle FOREIGN KEY (puzzle_id) REFERENCES puzzles(id) ON DELETE RESTRICT,
    KEY idx_games_ended (ended_at),
    KEY idx_games_status (status)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS game_players (
    game_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    nickname VARCHAR(64) NOT NULL,
    is_bot TINYINT(1) DEFAULT 0,
    seat INT NOT NULL,
    questions_asked INT DEFAULT 0,
    score INT DEFAULT 0,
    stars INT DEFAULT 0,
    is_winner TINYINT(1) DEFAULT 0,
    PRIMARY KEY (game_id, user_id),
    CONSTRAINT fk_gp_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    KEY idx_gp_user (user_id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS game_chat (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    game_id CHAR(36) NOT NULL,
    round INT NOT NULL,
    seat INT NOT NULL,
    nickname VARCHAR(64) NOT NULL,
    question TEXT NOT NULL,
    judgment VARCHAR(32),
    close_hint TINYINT(1) DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    KEY idx_chat_game (game_id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS admins (
    id CHAR(36) NOT NULL PRIMARY KEY,
    account VARCHAR(191) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name VARCHAR(64) NOT NULL,
    role VARCHAR(32) NOT NULL,
    email VARCHAR(191),
    token_version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS ai_providers (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    format VARCHAR(32) NOT NULL,
    base_url VARCHAR(512) NOT NULL,
    api_key TEXT NOT NULL,
    enabled TINYINT(1) DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS ai_models (
    id CHAR(36) NOT NULL PRIMARY KEY,
    provider_id CHAR(36) NOT NULL,
    name VARCHAR(128) NOT NULL,
    model_id VARCHAR(191) NOT NULL,
    context_window INT DEFAULT 128000,
    max_output INT DEFAULT 4096,
    modalities TEXT,
    enabled TINYINT(1) DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_models_provider FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE CASCADE,
    KEY idx_models_provider (provider_id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS ai_roles (
    id CHAR(36) NOT NULL PRIMARY KEY,
    role_key VARCHAR(191) NOT NULL UNIQUE,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    is_builtin TINYINT(1) DEFAULT 0,
    polling_strategy VARCHAR(32) DEFAULT 'round_robin',
    enabled TINYINT(1) DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS ai_role_models (
    id CHAR(36) NOT NULL PRIMARY KEY,
    role_id CHAR(36) NOT NULL,
    model_id CHAR(36) NOT NULL,
    priority INT DEFAULT 0,
    weight INT DEFAULT 1,
    enabled TINYINT(1) DEFAULT 1,
    sort_order INT DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_role_model (role_id, model_id),
    CONSTRAINT fk_rm_role FOREIGN KEY (role_id) REFERENCES ai_roles(id) ON DELETE CASCADE,
    CONSTRAINT fk_rm_model FOREIGN KEY (model_id) REFERENCES ai_models(id) ON DELETE CASCADE,
    KEY idx_rm_role (role_id)
  ) ${TABLE_OPTIONS}`,
];

async function initSchema() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await pool.query(stmt);
  }

  // 幂等迁移：为已存在的数据库补充 token_version 列（新建库已包含于 CREATE TABLE）
  for (const table of ['users', 'admins']) {
    try {
      await pool.execute(`ALTER TABLE ${table} ADD COLUMN token_version INT NOT NULL DEFAULT 0`);
    } catch (e) {
      if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
  }

  // 内置角色种子
  const seedRoles = [
    { key: 'judge', name: '游戏判定', desc: '海龟汤游戏内判定玩家提问：是 / 不是 / 无关 + 是否接近真相' },
    { key: 'bot_question', name: '补位 AI 提问', desc: 'AI 机器人玩家回合时生成提问' },
  ];
  const seedSql =
    `INSERT IGNORE INTO ai_roles (id, role_key, name, description, is_builtin, polling_strategy)
     VALUES (?, ?, ?, ?, 1, 'round_robin')`;
  for (const r of seedRoles) {
    await pool.execute(seedSql, [uuidv4(), r.key, r.name, r.desc]);
  }
}

module.exports = { pool, query, getOne, run, withTransaction, initSchema };
