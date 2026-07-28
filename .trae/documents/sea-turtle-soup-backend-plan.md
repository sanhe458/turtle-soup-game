# 海龟汤游戏后端实现计划

## 一、摘要

为现有的纯前端静态原型（6 个 HTML 页面）从零构建完整的后端服务，实现：用户昵称本地缓存免登录、混合匹配（真人优先 + 30 秒超时询问 AI 补位）、基于真实 LLM 的提问判定、3 人轮流提问的实时对局、汤底揭晓、以及管理后台（登录 / 总览 / 题库 CRUD）。

技术栈：**Node.js + Express + Socket.IO + SQLite + Zhipu GLM API**。

---

## 二、当前状态分析（基于探索）

| 维度 | 现状 |
|------|------|
| 后端 | **完全不存在**（无 server.js / package.json / 任何 API） |
| 前端 | 6 个 HTML 页面，原生 JS + Tailwind CSS v4 (CDN) + Lucide 图标 |
| API 调用 | 代码库中 **0 个 fetch / 0 个 WebSocket** |
| 数据 | 全部硬编码 mock（题目、玩家、聊天记录、统计、KPI 等） |
| 业务事件 | 所有按钮（确认 / 开始匹配 / 登录 / 发送 / 保存等）**无任何事件绑定** |
| admin-login 表单 | 显式 `onsubmit="return false;"` 主动阻止提交 |
| 实时能力 | game-play 页面设计依赖实时（倒计时 / 轮次切换 / 跨玩家消息），但无任何实现 |

**页面清单**：
- `/workspace/pages/match-hall.html` — 匹配大厅（昵称输入 + 统计 + 最近对局 + 开始匹配）
- `/workspace/pages/game-play-v2.html` — 对局中（汤面 + 问答区 + 玩家面板 + 进度面板）
- `/workspace/pages/answer-reveal-v2.html` — 汤底揭晓（冠军 + 真相 + 玩家表现 + 总结）
- `/workspace/pages/admin-login.html` — 管理员登录
- `/workspace/pages/admin-dashboard.html` — 管理总览（KPI + 趋势图 + 表格 + 分布）
- `/workspace/pages/admin-puzzles.html` — 题库管理（列表 + 筛选 + 编辑抽屉）

---

## 三、架构决策（来自用户确认）

1. **匹配模式**：混合模式。玩家入队后优先匹配真人；30 秒未凑齐 3 人则询问该玩家是否接受 AI 机器人补位；接受则立即开局，不接受则重置计时器继续等待。
2. **AI 判定**：真实 LLM API（Zhipu GLM，`glm-4-flash` 模型，免费额度足够原型使用）。LLM 同时负责判定"是/不是/无关"与"是否接近真相"。
3. **技术栈**：Node.js + Express + Socket.IO。
4. **用户身份**：免登录，昵称存 localStorage；后端用一次性 JWT 标识匿名用户身份（无密码）。
5. **管理员身份**：账号 + 密码登录，密码 bcrypt 哈希存数据库；JWT 鉴权。

---

## 四、文件结构

新增后端目录与前端 JS 目录，保留现有 HTML 页面并最小化修改：

```
/workspace
├── server/                              # 【新增】后端服务
│   ├── package.json
│   ├── .env.example
│   ├── .gitignore
│   ├── src/
│   │   ├── index.js                     # 入口：Express + Socket.IO 启动
│   │   ├── config.js                    # 配置（端口 / JWT密钥 / LLM配置 / 超时）
│   │   ├── db.js                        # SQLite 初始化 + schema + 种子数据
│   │   ├── routes/
│   │   │   ├── userRoutes.js            # /api/users, /api/user/*
│   │   │   ├── adminRoutes.js           # /api/admin/*
│   │   │   └── puzzleRoutes.js          # /api/puzzles/*（公开读取）
│   │   ├── sockets/
│   │   │   ├── matchSocket.js           # 匹配队列逻辑（混合模式）
│   │   │   └── gameSocket.js            # 对局状态机 + 实时事件
│   │   ├── services/
│   │   │   ├── llmService.js            # Zhipu GLM API 封装（判定 + bot提问 + 接近真相）
│   │   │   ├── botService.js            # AI 机器人玩家（提问节奏 + 模拟延迟）
│   │   │   ├── matchService.js          # 匹配队列状态管理
│   │   │   └── gameService.js           # 对局逻辑（轮次 / 计时 / 进度 / 揭晓）
│   │   ├── middleware/
│   │   │   ├── userAuth.js              # 用户 JWT 验证（宽松，匿名身份）
│   │   │   └── adminAuth.js             # 管理员 JWT 验证（严格）
│   │   └── utils/
│   │       ├── jwt.js                   # JWT 签发 / 验证
│   │       └── prompts.js               # LLM prompt 模板
│   └── seed.js                          # 种子数据脚本（题目 + 管理员）
├── js/                                  # 【新增】前端共享 JS
│   ├── api.js                           # fetch 封装 + API 基址 + token 管理
│   ├── socket.js                        # Socket.IO 客户端单例
│   └── helpers.js                       # 渲染辅助（格式化时间 / DOM 工具）
├── pages/                               # 【修改】现有 6 个 HTML 页面
│   ├── match-hall.html                  # 接入昵称保存 + 匹配 + 统计加载
│   ├── game-play-v2.html                # 接入 Socket.IO 对局 + 动态渲染
│   ├── answer-reveal-v2.html            # 接入揭晓数据加载
│   ├── admin-login.html                 # 接入登录 API
│   ├── admin-dashboard.html             # 接入 KPI / 列表加载
│   └── admin-puzzles.html               # 接入题库 CRUD
├── assets/                              # 【保留】
├── colors_and_type.css                  # 【保留】
└── (其他保留文件)
```

---

## 五、数据库 Schema（SQLite，better-sqlite3）

```sql
-- 用户（匿名身份，无密码）
CREATE TABLE users (
  id TEXT PRIMARY KEY,             -- UUID
  nickname TEXT NOT NULL,
  avatar_seed TEXT,                -- 用于生成渐变头像
  total_games INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  current_streak INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 题库
CREATE TABLE puzzles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scenario TEXT NOT NULL,          -- 汤面
  truth TEXT NOT NULL,             -- 汤底
  difficulty TEXT NOT NULL,        -- easy / medium / hard
  status TEXT NOT NULL DEFAULT 'online',  -- online / pending / offline
  tags TEXT,                       -- JSON 数组字符串
  play_count INTEGER DEFAULT 0,
  rating INTEGER DEFAULT 90,       -- 好评率 0-100
  created_at TEXT DEFAULT (datetime('now'))
);

-- 对局
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  puzzle_id TEXT NOT NULL REFERENCES puzzles(id),
  status TEXT NOT NULL,            -- playing / revealed / abandoned
  current_round INTEGER DEFAULT 1,
  max_rounds INTEGER DEFAULT 10,
  progress INTEGER DEFAULT 0,      -- 0-100
  winner_user_id TEXT,             -- 可空（可能无人胜）
  duration_sec INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

-- 对局玩家
CREATE TABLE game_players (
  game_id TEXT NOT NULL REFERENCES games(id),
  user_id TEXT NOT NULL,           -- 真人为 users.id，bot 为 bot_xxx
  nickname TEXT NOT NULL,
  is_bot INTEGER DEFAULT 0,
  seat INTEGER NOT NULL,           -- 0/1/2 座位号
  questions_asked INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  stars INTEGER DEFAULT 0,
  is_winner INTEGER DEFAULT 0,
  PRIMARY KEY (game_id, user_id)
);

-- 对局聊天记录
CREATE TABLE game_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL REFERENCES games(id),
  round INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  question TEXT NOT NULL,
  judgment TEXT,                   -- yes / no / irrelevant
  close_hint INTEGER DEFAULT 0,    -- 是否触发"接近真相"提示
  created_at TEXT DEFAULT (datetime('now'))
);

-- 管理员
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  account TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  email TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## 六、REST API 设计

### 用户端（免登录，JWT 匿名身份）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/api/users/register` | 提交昵称获取身份 | `{ nickname }` | `{ userId, nickname, token }` |
| GET | `/api/user/profile` | 个人统计 | (Bearer token) | `{ todayGames, winRate, streak }` |
| GET | `/api/user/recent-games` | 最近对局 | (Bearer token) | `[{ gameId, opponents, result, timeAgo }]` |
| GET | `/api/puzzles/:id` | 题目详情（仅汤面，不含汤底） | - | `{ id, title, scenario, difficulty, tags, playCount }` |
| GET | `/api/game/:id/reveal` | 揭晓数据 | (Bearer token) | `{ winner, truth, originalScenario, playersStats, totalRounds, duration, puzzle }` |

### 管理端（账号密码登录 + JWT）

| 方法 | 路径 | 用途 | 请求 | 响应 |
|------|------|------|------|------|
| POST | `/api/admin/login` | 登录 | `{ account, password }` | `{ token, admin: { name, role, email } }` |
| GET | `/api/admin/dashboard` | 总览 KPI | (Bearer admin token) | `{ kpi, userGrowth, recentGames, difficultyDist, hotPuzzles, pendingTasks }` |
| GET | `/api/admin/puzzles` | 题库列表 | `?difficulty&status&search&page&limit` | `{ items, total, page }` |
| POST | `/api/admin/puzzles` | 新建题目 | `{ title, scenario, truth, difficulty, tags }` | `{ puzzle }` |
| PUT | `/api/admin/puzzles/:id` | 编辑题目 | 同上 | `{ puzzle }` |
| PATCH | `/api/admin/puzzles/:id/status` | 改状态 | `{ status }` | `{ puzzle }` |

---

## 七、Socket.IO 事件设计

### 客户端 → 服务端

| 事件 | 数据 | 说明 |
|------|------|------|
| `match:join` | `{ token }` | 加入匹配队列 |
| `match:cancel` | - | 取消匹配 |
| `match:accept_bots` | - | 30秒超时后接受 AI 补位 |
| `match:decline_bots` | - | 拒绝，继续等待 |
| `game:question` | `{ question }` | 提交提问 |
| `game:leave` | - | 离开对局 |

### 服务端 → 客户端

| 事件 | 数据 | 说明 |
|------|------|------|
| `match:status` | `{ position, waitedSec }` | 队列位置与等待秒数 |
| `match:bot_prompt` | `{ message }` | 30秒到，询问是否接受 AI 补位 |
| `match:success` | `{ gameId, players, puzzle }` | 匹配成功，准备进入对局 |
| `match:cancelled` | `{ reason }` | 匹配被取消 |
| `game:start` | `{ puzzle, players, maxRounds, yourSeat }` | 对局开始，下发题目与座位 |
| `game:turn` | `{ round, seat, nickname, timerSec }` | 轮到某玩家，开始倒计时 |
| `game:question_posted` | `{ round, seat, nickname, question }` | 某玩家提问 |
| `game:judgment` | `{ judgment, closeHint, progress, stats }` | AI 判定结果（广播全桌） |
| `game:insight` | `{ message }` | AI 洞察提示（如"有人在接近真相…"） |
| `game:reveal` | `{ gameId, winner }` | 触发揭晓，前端跳转 reveal 页 |
| `game:end` | `{ reason }` | 对局结束（无人胜 / 10轮满） |
| `error` | `{ message }` | 错误提示 |

---

## 八、核心逻辑设计

### 8.1 匹配队列（混合模式）

```
MatchQueue = FIFO 队列，每项 = { socketId, userId, nickname, joinedAt, botPrompted }

定时器（每 1 秒）：
  - 若 queue.length >= 3：取前 3 个，创建对局，向 3 人 emit match:success
  - 对队列中每个等待者：
    - waitedSec = now - joinedAt
    - 若 waitedSec >= 30 且未发过 bot_prompt：
      emit match:bot_prompt 给该玩家
      标记 botPrompted = true
  - （bot_prompt 的响应处理见下）

on match:accept_bots:
  - 取该玩家 + 队列中其他真人（0~2 个）+ AI 机器人补足到 3 人
  - 创建对局，emit match:success 给真人玩家
  - 从队列移除被取走的真人

on match:decline_bots:
  - 重置 joinedAt = now，botPrompted = false
  - 继续留在队列等待
```

### 8.2 对局状态机

```
状态：waiting_question → judging → next_turn → (循环) → reveal / end

每个轮次：
  1. 服务端 emit game:turn { round, seat, nickname, timerSec: 15 }
  2. 启动 15 秒倒计时，每秒广播 game:timer（前端展示倒计时）
  3. 等待该座位玩家 emit game:question
     - 若是真人：等待 socket 事件
     - 若是 AI bot：调用 botService 生成问题，模拟 3-6 秒延迟后提交
  4. 收到问题后：emit game:question_posted 给全桌
  5. 调用 llmService.judge(scenario, truth, question, history)
  6. emit game:judgment { judgment, closeHint, progress, stats }
  7. 若 closeHint=true 或当前轮次 >= maxRounds：
     - 触发揭晓：emit game:reveal，写入 games 表
  8. 否则：轮到下一座位，回到步骤 1
  9. 15 秒超时未提问：
     - 真人：自动跳过，记录"未提问"
     - bot：不应发生（bot 总会提问）
```

### 8.3 LLM 服务（Zhipu GLM）

**判定 prompt**（结构化输出）：
```
你是海龟汤游戏主持人。

汤面：{scenario}
汤底（真相）：{truth}

历史问答：
{history}

玩家新提问：{question}

请判断：
1. 该问题针对汤底的答案是「是」「不是」还是「无关」？
2. 玩家是否在接近真相（提问方向触及汤底核心要素）？

严格返回 JSON：
{"judgment": "yes|no|irrelevant", "close_to_truth": true|false}
```

**Bot 提问 prompt**：
```
你是海龟汤游戏的 AI 玩家。

汤面：{scenario}
历史问答：{history}

请提出一个有助于推理的问题，必须能用「是/不是/无关」回答。

严格返回 JSON：
{"question": "你的问题"}
```

**模型**：`glm-4-flash`（免费额度，响应快）；超时 8 秒；失败重试 1 次。

**降级策略**（开发环境无 API Key 时）：返回固定 `{"judgment": "irrelevant", "close_to_truth": false}`，并在日志警告。生产环境必须配置 `ZHIPU_API_KEY`。

### 8.4 AI 机器人玩家

- 名字池：`["推理达人", "逻辑大师", "海龟学徒", "谜题猎手", "侦探少女"]` 随机选 2 个不重复
- 提问节奏：轮到 bot 时，模拟 3-6 秒"思考"延迟，让真人有节奏感
- bot 通过 LLM 生成问题（与判定共用 LLM 服务）
- bot 的提问同样走判定流程，结果广播全桌

### 8.5 进度计算

`progress`（0-100）= 基于历史提问中 `close_to_truth=true` 的次数与轮次进度加权：
```
progress = min(100, (closeCount * 20) + (currentRound / maxRounds) * 30)
```
当 `close_to_truth=true` 且 `progress >= 80` 时，额外触发 `game:insight` 推送"有人在接近真相…"。

### 8.6 揭晓与计分

- **触发条件**：LLM 返回 `close_to_truth=true`（连续 2 次）或 `currentRound >= maxRounds`
- **胜者**：最后一次触发 `close_to_truth=true` 的玩家为"推理之星"；若无人触发则无胜者
- **星级**：基于提问次数与 close 次数：1-5 星
- **得分**：每题 +2，close_hint 额外 +10
- 写入 `games` / `game_players` / `game_chat` 表，更新 `users` 统计

---

## 九、前端修改（逐页面）

### 9.1 match-hall.html

**修改点**：
- 移除硬编码的统计数字（5 / 72% / 3）与最近对局列表
- 给统计区元素加 `id`（如 `#stat-today`、`#stat-winrate`、`#stat-streak`）
- 给最近对局容器加 `id="recent-games-list"`
- 昵称"确认"按钮：从 localStorage 读取已存昵称回填；点击时保存到 localStorage 并调用 `POST /api/users/register` 获取 token 存 localStorage
- "开始匹配"按钮：调用 `socket.emit('match:join', { token })`，监听 `match:status` / `match:bot_prompt` / `match:success`
- 收到 `match:bot_prompt` 时弹出确认对话框（玻璃拟态卡片），用户选择后 emit `match:accept_bots` 或 `match:decline_bots`
- 收到 `match:success` 后 `location.href = 'game-play-v2.html?gameId=xxx'`
- 页面加载时若 localStorage 已有 token，调用 `GET /api/user/profile` 与 `GET /api/user/recent-games` 渲染统计与列表

### 9.2 game-play-v2.html

**修改点**：
- 移除全部硬编码聊天记录、玩家面板数据、进度数据
- 解析 URL `?gameId=xxx`，建立 Socket.IO 连接（加入房间 `game:{gameId}`）
- 监听 `game:start`：渲染汤面、难度、标签、3 个玩家面板（座位号区分）
- 监听 `game:turn`：高亮当前提问玩家，启动倒计时显示
- 监听 `game:question_posted`：在聊天区追加消息气泡
- 监听 `game:judgment`：更新该问题的判定图标（是=绿✓ / 不是=红✗ / 无关=琥珀−），更新右侧进度面板（进度条 / 是不是无关统计 / 贡献排名）
- 监听 `game:insight`：在 AI 洞察区显示提示文字
- 监听 `game:reveal`：`location.href = 'answer-reveal-v2.html?gameId=xxx'`
- 发送按钮：当前轮次是本人且未提问时启用，点击 `socket.emit('game:question', { question })`
- 倒计时由服务端 `game:timer` 推送驱动（避免客户端时钟漂移）

### 9.3 answer-reveal-v2.html

**修改点**：
- 移除硬编码的冠军、汤底、玩家表现、对局总结
- 解析 URL `?gameId=xxx`，调用 `GET /api/game/:id/reveal` 获取数据
- 渲染：推理之星（winner）、汤底真相文本、原始汤面、3 个玩家表现卡片、对局总结（轮数 / 时长 / 题目 / 难度）
- "再来一局"按钮：`location.href = 'match-hall.html'`
- "返回大厅"按钮：同上

### 9.4 admin-login.html

**修改点**：
- 移除 `onsubmit="return false;"`，改为 JS 拦截提交
- 表单提交：调用 `POST /api/admin/login`，成功后存 token 到 localStorage，`location.href = 'admin-dashboard.html'`
- 失败时显示错误提示（移除 `opacity-0`）
- "记住登录"复选框：勾选时 token 存 localStorage，不勾选时存 sessionStorage

### 9.5 admin-dashboard.html

**修改点**：
- 页面加载时检查 localStorage/sessionStorage token，无则跳转 admin-login
- 调用 `GET /api/admin/dashboard`，渲染 4 个 KPI 卡片、用户增长柱状图、最近对局表格、难度分布、热门题目、待办事项
- 日期切换 tab（今日/本周/本月）：带参数重新调用 API
- 分页按钮：调用 `GET /api/admin/games?page=x`（如实现）

### 9.6 admin-puzzles.html

**修改点**：
- 页面加载时检查 token
- 调用 `GET /api/admin/puzzles?difficulty=&status=&search=&page=`，渲染表格
- 筛选器 change 事件：重新调用 API
- "添加新题"按钮：打开右侧抽屉（已有 CSS，补 JS toggle）
- 抽屉保存按钮：`POST /api/admin/puzzles`，成功后刷新列表
- 编辑按钮：`PUT /api/admin/puzzles/:id`
- 上线/下架/审核按钮：`PATCH /api/admin/puzzles/:id/status`
- 分页：`GET /api/admin/puzzles?page=x`

---

## 十、前端共享 JS（/js/ 目录）

### js/api.js
- `API_BASE` 常量（默认 `http://localhost:3000/api`，可被 `window.API_BASE` 覆盖）
- `getToken()` / `setToken()` / `clearToken()`：从 localStorage 读写
- `request(method, path, body)`：fetch 封装，自动带 `Authorization: Bearer <token>`，处理 401 跳转

### js/socket.js
- `getSocket()`：Socket.IO 单例，连接 `http://localhost:3000`，自动带 token query
- 全局可用 `window.socket`

### js/helpers.js
- `formatTimeAgo(date)`：格式化为"x分钟前"
- `formatDuration(sec)`：格式化为 mm:ss
- `el(html)`：从字符串创建 DOM 元素

---

## 十一、种子数据（seed.js）

- **管理员**：账号 `admin`，密码 `admin123`（bcrypt 哈希），姓名 `SuperAdmin`，角色 `超级管理员`，邮箱 `admin@turtlesoup.com`
- **题目**：6 道示例题（覆盖简单/中等/困难），包含前端已出现的"海边的神秘脚印"（与 game-play mock 一致，保证视觉连贯），其余 5 道为新题

---

## 十二、配置与环境变量

### server/.env.example
```
PORT=3000
JWT_SECRET=change-me-in-production
ZHIPU_API_KEY=your-zhipu-api-key-here
ZHIPU_MODEL=glm-4-flash
ADMIN_DEFAULT_PASSWORD=admin123
CLIENT_ORIGIN=http://localhost:8080
```

### server/package.json 关键依赖
- `express` — Web 框架
- `socket.io` — 实时通信
- `better-sqlite3` — SQLite 驱动（同步 API，简单高效）
- `jsonwebtoken` — JWT
- `bcryptjs` — 密码哈希
- `uuid` — 生成 ID
- `cors` — 跨域
- `dotenv` — 环境变量
- `node-fetch`（Node < 18）或原生 fetch（Node >= 18）— 调用 LLM API

### 启动方式
```bash
cd server
npm install
cp .env.example .env  # 填入 ZHIPU_API_KEY
npm run seed          # 初始化数据库 + 种子数据
npm start             # 启动服务，监听 3000
```

### 前端访问方式
前端 HTML 通过任意静态服务器访问（如 `npx serve .` 监听 8080），`js/api.js` 中 `API_BASE` 指向后端 `http://localhost:3000/api`。

---

## 十三、假设与决策

1. **数据库选 SQLite**：文件型、零配置、单文件部署，适合原型；生产可平滑迁移到 PostgreSQL。
2. **LLM 模型用 glm-4-flash**：Zhipu AI 免费额度足够原型使用；可通过环境变量切换为 glm-4。
3. **无 API Key 时的降级**：返回 `irrelevant` 判定并日志告警，保证游戏可跑通流程但不影响真实体验。生产必须配置 Key。
4. **管理员账号默认 admin/admin123**：种子数据初始化，可在 `.env` 中改密码。
5. **15 秒提问倒计时**：与 game-play 页面 `00:15` 一致；真人超时自动跳过轮次。
6. **bot 模拟思考延迟 3-6 秒**：避免 bot 瞬间提问破坏节奏感。
7. **页面间传参用 URL `?gameId=`**：简单直接，无需前端路由库。
8. **前端静态资源由独立静态服务器提供**：后端只提供 API + WebSocket，不托管前端 HTML（保持前端可独立部署）。后端配置 CORS 允许前端域名。
9. **不修改现有视觉设计**：所有 HTML 修改仅增加 `id` 属性、移除 mock 文本、追加 `<script>` 调用，不改变视觉布局。
10. **管理后台路由保护**：用前端 JS 检查 token + 后端 API 鉴权双重保护（前端检查可绕过，后端鉴权是真实防线）。

---

## 十四、验证步骤

### 后端验证
1. `cd server && npm install` 成功，无依赖错误
2. `npm run seed` 创建 `server/data.db`，包含 6 道题 + 1 管理员
3. `npm start` 启动，控制台显示 `Server running on port 3000` 与 `Socket.IO ready`
4. 用 curl 测试：
   - `POST /api/users/register { nickname: "测试" }` 返回 token
   - `POST /api/admin/login { account: "admin", password: "admin123" }` 返回 admin token
   - `GET /api/admin/puzzles` 带管理员 token 返回题目列表
5. 配置 `ZHIPU_API_KEY` 后，单独测试 `llmService.judge()` 返回合法 JSON

### 前端验证
6. 用 `npx serve .` 启动前端，访问 `pages/match-hall.html`
7. 输入昵称 → 确认 → localStorage 出现 token 与 nickname
8. 点击"开始匹配" → 30 秒内若无人匹配，弹出"是否接受 AI 补位"对话框
9. 接受 AI 补位 → 跳转 `game-play-v2.html?gameId=xxx`
10. 对局页面：汤面正确显示，3 个玩家面板（1 真人 + 2 bot）
11. 轮到真人时输入框启用，提问后收到 AI 判定（是/不是/无关）
12. 轮到 bot 时，3-6 秒后自动出现 bot 提问与判定
13. 进度面板实时更新（进度条 / 统计 / 贡献排名）
14. 触发揭晓条件后跳转 `answer-reveal-v2.html?gameId=xxx`
15. 揭晓页正确显示汤底、玩家表现、对局总结
16. 访问 `pages/admin-login.html` → 用 admin/admin123 登录 → 跳转 dashboard
17. Dashboard KPI / 表格 / 图表正确加载
18. 题库管理页：列表 / 筛选 / 新建 / 编辑 / 上下架功能正常

### 实时性验证
19. 开两个浏览器窗口（不同昵称）同时匹配 → 30 秒内若第 3 人加入则 3 真人成局
20. 对局中一窗口提问，另一窗口实时看到提问与判定
