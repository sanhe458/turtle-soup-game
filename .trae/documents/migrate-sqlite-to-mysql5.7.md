# 将数据库从 SQLite (better-sqlite3) 迁移到 MySQL 5.7

## 摘要

把 [server/src/db.js](file:///workspace/server/src/db.js) 中基于 `better-sqlite3` 的同步 SQLite 数据层，整体替换为基于 `mysql2/promise` 的异步连接池 + MySQL 5.7 schema。由于 `better-sqlite3` 的 API 是同步的，而 `mysql2` 必须异步，因此需要把所有调用 DB 的中间件 / 路由 / 服务函数由「同步」改造为 `async/await`，并把唯一的 `db.transaction(...)` 包装改写为 `beginTransaction / commit / rollback`。SQL 方言层面做最小必要的等价改写（`datetime('now')`→`NOW()`、`AUTOINCREMENT`→`AUTO_INCREMENT`、`INSERT OR IGNORE`→`INSERT IGNORE`、`RANDOM()`→`RAND()`、`GROUP_CONCAT(col, sep)`→`GROUP_CONCAT(col SEPARATOR sep)`）。schema 类型做必要的 MySQL 化（`TEXT PRIMARY KEY` UUID → `CHAR(36)`，`TEXT UNIQUE` → `VARCHAR(n) UNIQUE`，时间列改为 `DATETIME DEFAULT CURRENT_TIMESTAMP`，布尔列用 `TINYINT(1)`，引擎 `InnoDB`，字符集 `utf8mb4`）。数据采用全新 seed（`seed.js` 原本就在非生产环境删除 `data.db` 重建，等价于「重置后种子」语义，因此不写历史数据迁移脚本）。

## 现状分析

### 数据层入口
- [server/src/db.js](file:///workspace/server/src/db.js)：唯一 schema 定义点。`initSchema()` 在模块加载时同步执行 `db.exec(...)` 创建 10 张表，并通过 `INSERT OR IGNORE` 内置 2 个 AI 角色。模块导出 better-sqlite3 实例。
- 依赖：[server/package.json](file:///workspace/server/package.json) `better-sqlite3 ^11.3.0`，`engines.node >=18`。
- 配置：[server/src/config.js](file:///workspace/server/src/config.js) 仅校验 JWT / admin 口令 / KEK，不包含任何 DB 配置。[server/.env.example](file:///workspace/server/.env.example) 没有 DB 相关变量。

### DB 使用面（共 9 个文件 import `../db`）
- [server/src/middleware/adminAuth.js](file:///workspace/server/src/middleware/adminAuth.js)：`adminAuth(req,res,next)` 同步中间件，`db.prepare('SELECT id, token_version FROM admins WHERE id = ?').get(decoded.id)`。
- [server/src/middleware/userAuth.js](file:///workspace/server/src/middleware/userAuth.js)：`userAuth` 与 `optionalUserAuth` 两个同步中间件，同样 `SELECT id, token_version FROM users WHERE id = ?`。
- [server/src/routes/adminRoutes.js](file:///workspace/server/src/routes/adminRoutes.js)：登录 / 退出 / dashboard KPI / 题库 CRUD。dashboard handler 在一个同步函数里做了 8+ 次 `db.prepare(...).get(...).c` 计数查询。题库列表使用 `LIMIT ? OFFSET ?` 与 `LIKE` 搜索；recent games 用 `GROUP_CONCAT(nickname, ', ')`。
- [server/src/routes/aiRoutes.js](file:///workspace/server/src/aiRoutes.js)：供应商 / 模型 / 角色 / 绑定 CRUD。多处 `UPDATE ... SET updated_at = datetime('now')`。`PUT /admin/ai/roles/:id/models` 内唯一的 `db.transaction(() => {...})();` 同步事务。
- [server/src/routes/puzzleRoutes.js](file:///workspace/server/src/routes/puzzleRoutes.js)：单条同步 `SELECT ... WHERE id = ? AND status = 'online'`。
- [server/src/routes/userRoutes.js](file:///workspace/server/src/routes/userRoutes.js)：注册 / 退出 / profile / recent-games / reveal，均为同步 handler。`getRevealDataForUser` 在内部调用 gameService 的同步 DB 读取。
- [server/src/services/aiConfigService.js](file:///workspace/server/src/services/aiConfigService.js)：所有导出函数同步。`listRoles` 在 `.map()` 内做 N+1 同步 `SELECT COUNT(*) FROM ai_role_models WHERE role_id = ?`。`hasEnabledProvider()` 被 [server/src/index.js](file:///workspace/server/src/index.js) 在 `server.listen` 回调里同步调用做启动告警。
- [server/src/services/gameService.js](file:///workspace/server/src/services/gameService.js)：`createGame`、`pickRandomPuzzle`、`nextTurn`、`revealGame`、`getRevealData`、`getRevealDataForUser` 同步写读 DB。`receiveQuestion` 已是 `async`（含 `await llmService.judgeQuestion`），但其中 `INSERT INTO game_chat` 与 `nextTurn(...)` 仍是同步调用。`revealGame` 在 `forEach` 内做多次 `UPDATE game_players` 与 `UPDATE users`。`pickRandomPuzzle` 使用 `ORDER BY RANDOM() LIMIT 1`。
- [server/src/services/aiRouter.js](file:///workspace/server/src/services/aiRouter.js#L232-L233)：`callRole` 已是 `async`，但 `const roleConfig = aiConfig.getRoleByKey(roleKey)` 同步取值，需改 `await`。
- [server/seed.js](file:///workspace/server/seed.js)：非生产环境 `fs.unlinkSync(DB_PATH)` 删除旧库文件后 `require('./src/db')` 触发 schema，再插 admin + 6 道题。

### 关键约束（来自代码审计）
1. 所有占位符均为 `?`（无 named params），mysql2 兼容。
2. 没有使用 `OR REPLACE` / `ON CONFLICT` / upsert；只有 1 处 `INSERT OR IGNORE`。
3. 没有 `db.iterate()`、没有读取 `stmt.run().lastInsertRowid` / `.changes`，所有 INSERT 都用 JS 生成的 UUID 重新 SELECT。
4. JSON 列（`puzzles.tags`、`ai_models.modalities`）以纯 `TEXT` 存储，在 JS 层 `JSON.stringify/parse`，未用 SQLite JSON 函数。
5. 布尔以 `INTEGER 0/1` 存储，读取时 `!!x` 强转。
6. 字符串拼接 `||`、命名参数、`PRAGMA`（除 db.js 顶部 2 行外）均未在 SQL 层使用。
7. 唯一事务在 [aiRoutes.js#L277-L292](file:///workspace/server/src/routes/aiRoutes.js#L277-L292)。
8. `better-sqlite3` 是同步 API；`mysql2` 必须 async。Express 4 不会自动捕获 async 中间件 rejected promise，需 try/catch 或 async wrapper。

## 改造方案

### 1. 依赖与配置

**[server/package.json](file:///workspace/server/package.json)**
- `dependencies` 中删除 `"better-sqlite3": "^11.3.0"`，新增 `"mysql2": "^3.11.0"`。
- 其余依赖不动。

**[server/src/config.js](file:///workspace/server/src/config.js)**
- 新增 MySQL 配置项（从环境变量读取）：
  - `db.host` (默认 `127.0.0.1`)、`db.port` (默认 `3306`)、`db.user`、`db.password`、`db.database` (默认 `turtle_soup`)、`db.connectionLimit` (默认 `10`)。
- 新增启动校验：`DB_USER` 与 `DB_PASSWORD` 必须设置；缺失则 `console.error` 并 `process.exit(1)`（与现有 JWT_SECRET 校验风格一致）。
- 在导出对象里增加 `db` 字段。

**[server/.env.example](file:///workspace/.env.example)**
- 追加 DB 段：
  ```
  # MySQL 5.7 数据库
  DB_HOST=127.0.0.1
  DB_PORT=3306
  DB_USER=turtle
  DB_PASSWORD=changeme-generate-a-strong-password
  DB_DATABASE=turtle_soup
  DB_CONNECTION_LIMIT=10
  ```

### 2. 重写 [server/src/db.js](file:///workspace/server/src/db.js)

替换为基于 `mysql2/promise` 的连接池 + 异步 helper 模块。导出对象保持「单一 db 模块」形态，但接口改为 async：

```js
const mysql = require('mysql2/promise');
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

// 便捷封装：所有 ? 占位符行为与 better-sqlite3 一致
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
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function initSchema() {
  // 见下方 schema（多语句模式需用 pool.query 而非 execute；或拆成多次 execute）
}

module.exports = { pool, query, getOne, run, withTransaction, initSchema };
```

要点：
- 删除 `db.pragma('journal_mode = WAL')` / `db.pragma('foreign_keys = ON')`（MySQL 无对应概念；InnoDB 默认开启 FK 检查）。
- `initSchema()` 改为 `async`，由 [server/src/index.js](file:///workspace/server/src/index.js) 在 `server.listen` 之前 `await initSchema()` 调用（不再靠模块加载副作用）。
- 内置角色种子（原 `INSERT OR IGNORE INTO ai_roles`）改为 `INSERT IGNORE INTO ai_roles`，并在 `initSchema()` 末尾异步执行。
- 原 `try { ALTER TABLE ... ADD COLUMN token_version }` 的幂等迁移逻辑可删除——新 schema 直接包含 `token_version` 列，且由于走全新 seed，不存在历史库需要补列的场景。为保留向前兼容（万一库已存在），可改为 `ALTER TABLE ... ADD COLUMN ...` 包在 `try/catch` 内并捕获 `ER_DUP_FIELDNAME`，按需保留。决定：**保留**这两条 ALTER，用 `try/catch` 忽略 `ER_DUP_FIELDNAME`（错误码 1060），与原行为等价且无副作用。

### 3. MySQL 5.7 Schema（写在 `initSchema()` 内）

逐表翻译规则：
- `TEXT PRIMARY KEY` (UUID 36 字符) → `CHAR(36) NOT NULL PRIMARY KEY`
- `TEXT UNIQUE` → `VARCHAR(255) UNIQUE`（影响 `admins.account`、`ai_roles.role_key`；MySQL 5.7 + utf8mb4 索引上限 767 字节，VARCHAR(255) × 4 = 1020 字节会超限，因此用 `VARCHAR(191)`）
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY`
- `INTEGER DEFAULT 0/1`（布尔语义）→ `TINYINT(1) DEFAULT 0`
- 普通 `INTEGER` → `INT`
- `TEXT DEFAULT (datetime('now'))` 时间列 → `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `TEXT` (自由文本：scenario/truth/password_hash/api_key/description) → 保持 `TEXT`（MySQL 5.7 `TEXT` 64KB 上限足够；`scenario`/`truth` 校验上限 2000 字符，`password_hash` bcrypt 60 字符但保留 TEXT 无害）
- `tags TEXT` / `modalities TEXT` (JSON 字符串) → 保持 `TEXT`（JS 层仍 `JSON.stringify/parse`，零代码改动；不引入 MySQL JSON 列以避免写逻辑改动）
- 所有表追加 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`（`utf8mb4_unicode_ci` 使 `LIKE` 默认大小写不敏感，与 SQLite 行为一致）
- 外键列显式建索引（MySQL 要求 FK 列必须有索引；引用列已是 PK 不需要额外建）

最终 10 张表（节选关键差异）：

```sql
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  nickname VARCHAR(64) NOT NULL,
  avatar_seed VARCHAR(64),
  total_games INT DEFAULT 0,
  wins INT DEFAULT 0,
  current_streak INT DEFAULT 0,
  token_version INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS puzzles (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS games (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_players (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS game_chat (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admins (
  id CHAR(36) NOT NULL PRIMARY KEY,
  account VARCHAR(191) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  email VARCHAR(191),
  token_version INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_providers (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  format VARCHAR(32) NOT NULL,
  base_url VARCHAR(512) NOT NULL,
  api_key TEXT NOT NULL,
  enabled TINYINT(1) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_models (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_roles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  role_key VARCHAR(191) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  description TEXT,
  is_builtin TINYINT(1) DEFAULT 0,
  polling_strategy VARCHAR(32) DEFAULT 'round_robin',
  enabled TINYINT(1) DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_role_models (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

幂等迁移保留：
```js
try { await pool.execute('ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0'); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
try { await pool.execute('ALTER TABLE admins ADD COLUMN token_version INT NOT NULL DEFAULT 0'); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
```

内置角色种子：
```js
const seedStmt = `INSERT IGNORE INTO ai_roles (id, role_key, name, description, is_builtin, polling_strategy)
                  VALUES (?, ?, ?, ?, 1, 'round_robin')`;
for (const r of seedRoles) {
  await pool.execute(seedStmt, [uuidv4(), r.key, r.name, r.desc]);
}
```

### 4. 调用点 async 化（核心工作量）

统一的调用约定替换表（机械替换）：

| better-sqlite3 (同步) | mysql2 (异步) |
|---|---|
| `db.prepare(sql).get(...args)` | `await db.getOne(sql, [...args])` |
| `db.prepare(sql).all(...args)` | `await db.query(sql, [...args])` |
| `db.prepare(sql).run(...args)` | `await db.run(sql, [...args])` |
| `db.prepare(sql).get(...args).c` (取 COUNT 别名) | `(await db.getOne(sql, [...args])).c` |
| `db.prepare(sql).get(...args)?.c` | `(await db.getOne(sql, [...args]))?.c ?? 0` |
| `db.transaction(fn)();` | `await db.withTransaction(async (conn) => { ... 使用 conn.execute ... });` |
| `db.exec(sql)` | `await db.query(sql)` |
| `db.pragma(...)` | 删除 |

**逐文件改造清单**：

1. **[server/src/middleware/adminAuth.js](file:///workspace/server/src/middleware/adminAuth.js)**
   - `adminAuth(req,res,next)` → `async function adminAuth(req,res,next)`，整段 try 包内 `const admin = await db.getOne('SELECT id, token_version FROM admins WHERE id = ?', [decoded.id])`。整个 try/catch 保留，捕获 async rejected。`requireRole` 不涉及 DB，不变。

2. **[server/src/middleware/userAuth.js](file:///workspace/server/src/middleware/userAuth.js)**
   - `userAuth`、`optionalUserAuth` 都改 `async function`，内部 `await db.getOne(...)`。`optionalUserAuth` 的 `try/catch` 仍吞掉错误。

3. **[server/src/routes/adminRoutes.js](file:///workspace/server/src/routes/adminRoutes.js)**
   - `POST /admin/login` 已是 async，仅把 `db.prepare(...).get(account)` 改 `await db.getOne(..., [account])`。
   - `POST /admin/logout` 改 async handler。
   - `GET /admin/dashboard`：整个 handler 改 `async (req,res)=>{...}`，把 8+ 处 `db.prepare(...).get(...).c` 改 `(await db.getOne(...,[...])).c`；7 日循环里的 2 个 COUNT 查询分别 `await`。`recentGamesRows` 改 `await db.query(...)`，`GROUP_CONCAT(nickname, ', ')` 改 `GROUP_CONCAT(nickname SEPARATOR ', ')`，子查询里 `LIMIT 1` 在聚合外是 no-op，删除以避免 MySQL 语义歧义。难度分布、热门题目、待办 COUNT 全部 `await`。
   - `GET /admin/puzzles`：改 async，`total` 与 `items` 分别 `await`；`WHERE ${whereSql}` 拼接保持（仅值走 `?`，安全），`LIMIT ? OFFSET ?` 不变。
   - `POST /admin/puzzles`、`PUT /admin/puzzles/:id`、`PATCH /admin/puzzles/:id/status`：改 async，INSERT/UPDATE/SELECT 都 `await`。

4. **[server/src/routes/aiRoutes.js](file:///workspace/server/src/routes/aiRoutes.js)**
   - 所有 handler 改 async；`aiConfig.listProviders/getProvider/listModels/getRoleById/listRoles/getRoleBindingsAdmin` 调用全部加 `await`。
   - 5 处 `updated_at = datetime('now')` → `updated_at = NOW()`。
   - `PUT /admin/ai/roles/:id/models` 的事务重写：
     ```js
     await db.withTransaction(async (conn) => {
       await conn.execute('DELETE FROM ai_role_models WHERE role_id = ?', [req.params.id]);
       for (const [idx, b] of bindings.entries()) {
         await conn.execute(
           `INSERT INTO ai_role_models (id, role_id, model_id, priority, weight, enabled, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
           [uuidv4(), req.params.id, b.modelId,
            toFiniteNumber(b.priority, 0), toFiniteNumber(b.weight, 1),
            b.enabled === false ? 0 : 1,
            toFiniteNumber(b.sortOrder != null ? b.sortOrder : idx, idx)]
         );
       }
     });
     ```
   - 校验阶段里的 `db.prepare('SELECT id FROM ai_models WHERE id = ?').get(b.modelId)` 与 `db.prepare('SELECT id FROM ai_roles WHERE role_key = ?')...` 改 `await db.getOne(...)`。

5. **[server/src/routes/puzzleRoutes.js](file:///workspace/server/src/routes/puzzleRoutes.js)**
   - handler 改 async，`row = await db.getOne(..., [req.params.id])`。

6. **[server/src/routes/userRoutes.js](file:///workspace/server/src/routes/userRoutes.js)**
   - `register/logout/profile/recent-games/reveal` 全部 async。
   - `reveal` handler 里 `gameService.getRevealDataForUser(...)` 调用加 `await`（见下条）。
   - recent-games 的 `LEFT JOIN` SQL 不变（MySQL 兼容）。

7. **[server/src/services/aiConfigService.js](file:///workspace/server/src/services/aiConfigService.js)**
   - 所有导出函数改 `async`：`listProviders, getProvider, providerModelCount, listModels, getModel, listRoles, getRoleById, getRoleByKey, getRoleBindings, getRoleBindingsAdmin, hasEnabledProvider`。
   - `listRoles` 的 N+1 `.map` 改为 `for...of` + `await db.getOne('SELECT COUNT(*) as c FROM ai_role_models WHERE role_id = ?', [r.id])`，或一次性 `GROUP BY` 批量查询（推荐批量以避免 N+1）：
     ```js
     const counts = await db.query(
       `SELECT role_id, COUNT(*) as c FROM ai_role_models GROUP BY role_id`
     );
     const map = new Map(counts.map(x => [x.role_id, x.c]));
     // 在 map 内 modelCount: map.get(r.id) || 0
     ```
   - `getRoleByKey` 内部 `role.models = getRoleBindings(r.id)` → `role.models = await getRoleBindings(r.id)`。

8. **[server/src/services/aiRouter.js](file:///workspace/server/src/services/aiRouter.js#L232-L233)**
   - `callRole` 已 async：`const roleConfig = await aiConfig.getRoleByKey(roleKey);`。
   - 检查 `aiRouter.js` 其余位置是否有同步调用 aiConfig（搜 `aiConfig.`），同步改 async。

9. **[server/src/services/gameService.js](file:///workspace/server/src/services/gameService.js)**
   - `createGame(puzzle, players)` → `async function createGame`。3 处同步 DB 写（INSERT games / INSERT game_players forEach / UPDATE puzzles）改 `await`。`forEach` 内异步 → 改 `for...of` 循环。建议把 3 个写包进 `db.withTransaction`（原来 SQLite 也未包事务，但跨网络更易部分失败，借此补强；属最小必要改动）。
   - `pickRandomPuzzle` → `async`，`ORDER BY RANDOM()` → `ORDER BY RAND()`，`return await db.getOne(...)`。
   - `nextTurn` → `async`，`UPDATE games` 改 `await`。其调用点 `beginTurn/handleTurnTimeout/receiveQuestion` 内的 `nextTurn(...)` 调用加 `await`（注意 `setTimeout(() => beginTurn(...))` 内的异步调用需 `beginTurn` 自身 async 并捕获错误，避免 unhandled rejection）。
   - `revealGame` → `async`。`forEach` 内的 `UPDATE game_players` + `UPDATE users` 改 `for...of` + `await`；建议包 `withTransaction`。`UPDATE games ... ended_at = datetime('now')` → `ended_at = NOW()`。`revealGame` 被 `receiveQuestion` 与 `handleTurnTimeout` 间接调用，调用点加 `await`。
   - `receiveQuestion` 已 async：内部 `INSERT INTO game_chat` 改 `await`；`revealGame(...)` 加 `await`；`nextTurn(...)` 加 `await`。
   - `getRevealData(gameId)` → `async`，4 处 `SELECT` 改 `await db.getOne/query`。
   - `getRevealDataForUser(gameId, userId)` → `async`，`const data = await getRevealData(gameId)`；`const participant = await db.getOne('SELECT 1 FROM game_players WHERE game_id = ? AND user_id = ?', [gameId, userId])`。
   - `handleTurnTimeout` 与 `beginTurn` 通过 `setTimeout` 间接触发 `nextTurn/handleBotTurn`，需要把异步错误冒泡：在 `setTimeout` 回调内对返回的 promise `.catch(err => console.error(...))`，避免吞错。
   - `matchSocket.js` 中 `pickRandomPuzzle()` 与 `createGame()` 调用点（`onMatchSuccess` 内）加 `await`（确认 [server/src/sockets/matchSocket.js](file:///workspace/server/src/sockets/matchSocket.js) 已是 async；按 search 报告 `matchSocket.js:35/44` 在 `async function onMatchSuccess` 内，直接 `await` 即可）。

10. **[server/src/index.js](file:///workspace/server/src/index.js)**
    - 在 `server.listen` 之前 `await db.initSchema()`：把启动逻辑包进 `(async () => { await initSchema(); server.listen(...) })().catch(err => { console.error(err); process.exit(1); })`。
    - `server.listen` 回调里的 `aiConfig.hasEnabledProvider()` 改 `await aiConfig.hasEnabledProvider()`。

11. **[server/seed.js](file:///workspace/seed.js)**
    - 删除 `fs.unlinkSync(DB_PATH)` 与 `DB_PATH` 相关逻辑。改为：在 `async` main 内 `await db.initSchema()`，然后 `TRUNCATE` 所有业务表（顺序需尊重 FK：先 `ai_role_models`、`game_chat`、`game_players`、`games`、`ai_models`、`ai_providers`、`ai_roles`、`puzzles`、`users`、`admins`），或临时 `SET FOREIGN_KEY_CHECKS=0` 批量 TRUNCATE 再恢复。生产环境守卫（`NODE_ENV === 'production'` 时退出）保留。
    - admin INSERT 与 puzzle INSERT 改 `await db.run(...)`；puzzle 循环改 `for...of` + `await`。
    - 整体包进 `(async () => { ... })().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})`。

### 5. 验证步骤

1. **环境准备**：本地起 MySQL 5.7（`docker run --name ts-mysql -e MYSQL_ROOT_PASSWORD=... -e MYSQL_DATABASE=turtle_soup -e MYSQL_USER=turtle -e MYSQL_PASSWORD=... -p 3306:3306 mysql:5.7 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci`）。
2. **依赖安装**：`cd server && npm uninstall better-sqlite3 && npm install mysql2@^3.11.0`。
3. **配置 .env**：按 `.env.example` 填 `DB_*` 与既有 JWT/ADMIN/KEK 变量。
4. **Seed**：`npm run seed`，确认输出「管理员账号 admin 已创建」「已创建 6 道题目」「种子数据初始化完成」；连库确认 10 张表存在，`ai_roles` 含 2 条内置角色。
5. **启动**：`npm start`，确认日志 `[turtle-soup] Server running on port 3000` 且无未捕获异常；若未配置 AI 供应商，确认告警文案与原行为一致。
6. **冒烟回归**（手工或 curl）：
   - `POST /api/users/register` → 200 + token；DB `users` 多 1 行。
   - `POST /api/admin/login` (admin / ADMIN_DEFAULT_PASSWORD) → 200 + token；`POST /api/admin/logout` → 200；之后带旧 token 调 `GET /api/admin/dashboard` → 401（token_version 校验）。
   - 重新登录后 `GET /api/admin/dashboard` → 200，KPI 字段齐全；`userGrowth` 7 条。
   - `GET /api/admin/puzzles?limit=10` → 6 条；`?search=海` 过滤生效；`?difficulty=easy` 过滤生效。
   - `POST /api/admin/puzzles` → 200 + 新题；`PUT /:id`、`PATCH /:id/status` 生效。
   - `GET /api/puzzles/:id` (online 题目) → 200；offline 题目 → 404。
   - `GET /api/user/profile`、`GET /api/user/recent-games` → 200。
   - AI 配置：`GET /api/admin/ai/providers`、`POST /api/admin/ai/providers`、`PUT /:id`、`DELETE /:id`；`POST /api/admin/ai/models`、`PUT/DELETE`；`POST /api/admin/ai/roles`、`PUT /:id`、`PUT /:id/models`（事务路径）、`PATCH /:id/strategy`。
   - 端到端匹配 + 一局对局走完（两人 + 一 bot），确认 `game_chat`、`game_players`、`games` 落库正确，`reveal` 后 `users.total_games/wins/current_streak` 更新；`GET /api/game/:id/reveal` 仅参与者可读。
7. **事务验证**：故意让 `PUT /admin/ai/roles/:id/models` 中第 2 个 INSERT 失败（例如引用不存在 modelId），确认 `ai_role_models` 没有残留旧绑定也没有部分新绑定（事务回滚生效）。
8. **删除残留**：删除 `server/data.db` 文件（如存在），避免误以为还在用 SQLite。

## 假设与决策

1. **驱动选择**：`mysql2/promise` + 连接池。理由：标准库、零额外抽象、与现有「手写 SQL + `?` 占位符」风格一致；不引入 ORM/查询构建器（避免大幅重写）。`deasync` 同步包装方案被排除（会阻塞事件循环，破坏 Socket.IO 与 LLM 并发）。
2. **MySQL 版本**：严格 5.7。因此：避免 8.0 才有的 `CHECK` 约束增强、窗口函数、原生 `JSON_TABLE`；`utf8mb4` 索引按 767 字节限制处理（`VARCHAR(191)` 用于 UNIQUE 列）。`DEFAULT CURRENT_TIMESTAMP` 在 5.7 的 `DATETIME` 上支持（5.6.5+）。
3. **数据迁移**：不写历史数据迁移脚本。理由：`seed.js` 原本就在非生产环境 `fs.unlinkSync` 删除整库重建，项目处于「种子驱动」开发期，无生产数据需保留。生产环境部署时由运维另行 dump/restore（不在本计划范围）。
4. **JSON 列保留 TEXT**：`puzzles.tags`、`ai_models.modalities` 继续用 `TEXT` + JS 层 `JSON.stringify/parse`，不引入 MySQL `JSON` 类型，避免改动写逻辑。
5. **时间列**：`created_at` / `updated_at` 用 `DATETIME DEFAULT CURRENT_TIMESTAMP`。`updated_at` 在 UPDATE 时由应用层 `SET updated_at = NOW()` 显式赋值（与原 `datetime('now')` 行为一致；不引入 `ON UPDATE CURRENT_TIMESTAMP` 以保持与原代码语义等价，避免隐式行为差异）。
6. **boolean 保留 0/1**：`TINYINT(1)` 等价于原 `INTEGER 0/1`，JS 层 `!!x` 强转不变。
7. **字符集**：`utf8mb4_unicode_ci`，使 `LIKE` 默认大小写不敏感，匹配 SQLite 行为。
8. **UUID 列**：`CHAR(36)` 而非 `VARCHAR(36)`，定长利于索引；JS 层 `uuidv4()` 输出 36 字符不变。
9. **FK 索引**：MySQL 要求 FK 列有索引。在 schema 中显式声明 `KEY idx_*` 处理 `game_players.user_id`、`game_chat.game_id`、`games.status/ended_at`、`ai_models.provider_id`、`ai_role_models.role_id` 等热点查询列。
10. **事务**：`createGame`、`revealGame` 借此迁移补加事务（原 SQLite 也未包，属最小必要的数据完整性补强，不视为新增功能）。
11. **错误处理**：所有 async 中间件/handler 已有 try/catch 或受全局错误中间件保护；新增的 async handler 依赖现有全局错误中间件 [server/src/index.js#L66-L70](file:///workspace/server/src/index.js#L66-L70) 兜底（Express 5 才自动捕获 async 错误，本项目 Express 4 需在 handler 内 try/catch 或在路由层用 `asyncHandler` wrapper——决定：在每个 async handler 内显式 try/catch，避免引入新抽象）。

## 不在范围内

- 不引入 ORM（Sequelize/Prisma/Knex）。
- 不写历史 SQLite → MySQL 数据迁移脚本。
- 不改前端、不改 Socket.IO 协议、不改业务逻辑（仅同步→异步改造 + SQL 方言等价改写 + schema 类型化）。
- 不引入连接池之外的基础设施变更（不新增 Redis、不新增 Docker compose）。
- 不改 LLM/AI 业务、不改 JWT、不改加解密逻辑。
