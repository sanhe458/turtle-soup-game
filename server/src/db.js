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
  `);
}

initSchema();

module.exports = db;
