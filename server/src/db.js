const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      avatar_seed TEXT,
      total_games INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS puzzles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      scenario TEXT NOT NULL,
      truth TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'online',
      tags TEXT,
      play_count INTEGER DEFAULT 0,
      rating INTEGER DEFAULT 90,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      puzzle_id TEXT NOT NULL REFERENCES puzzles(id),
      status TEXT NOT NULL,
      current_round INTEGER DEFAULT 1,
      max_rounds INTEGER DEFAULT 10,
      progress INTEGER DEFAULT 0,
      winner_user_id TEXT,
      duration_sec INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS game_players (
      game_id TEXT NOT NULL REFERENCES games(id),
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      is_bot INTEGER DEFAULT 0,
      seat INTEGER NOT NULL,
      questions_asked INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      stars INTEGER DEFAULT 0,
      is_winner INTEGER DEFAULT 0,
      PRIMARY KEY (game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS game_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL REFERENCES games(id),
      round INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      question TEXT NOT NULL,
      judgment TEXT,
      close_hint INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      account TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      model_id TEXT NOT NULL,
      context_window INTEGER DEFAULT 128000,
      max_output INTEGER DEFAULT 4096,
      modalities TEXT DEFAULT '["text"]',
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_roles (
      id TEXT PRIMARY KEY,
      role_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      is_builtin INTEGER DEFAULT 0,
      polling_strategy TEXT DEFAULT 'round_robin',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ai_role_models (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES ai_roles(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
      priority INTEGER DEFAULT 0,
      weight INTEGER DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(role_id, model_id)
    );
  `);

  // 内置角色种子
  const { v4: uuidv4 } = require('uuid');
  const seedRoles = [
    { key: 'judge', name: '游戏判定', desc: '海龟汤游戏内判定玩家提问：是 / 不是 / 无关 + 是否接近真相' },
    { key: 'bot_question', name: '补位 AI 提问', desc: 'AI 机器人玩家回合时生成提问' },
  ];
  const seedStmt = db.prepare(
    `INSERT OR IGNORE INTO ai_roles (id, role_key, name, description, is_builtin, polling_strategy)
     VALUES (?, ?, ?, ?, 1, 'round_robin')`
  );
  seedRoles.forEach((r) => seedStmt.run(uuidv4(), r.key, r.name, r.desc));
}

initSchema();

module.exports = db;
