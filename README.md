# 海龟汤 — 在线推理游戏

三人成局，推理至上。AI 主持人判定提问，玩家通过「是 / 不是 / 无关」问答逐步逼近汤底真相。

## 项目简介

海龟汤（Turtle Soup）是一款多人在线推理问答游戏：

- 每局 3 名玩家（真人 + AI 机器人补位），轮流提问
- AI 根据汤底真相判定每个问题：是 / 不是 / 无关 / 或许是 / 或许不是
- 玩家提问越接近真相，得分越高；触及关键信息触发「接近真相」提示
- 连续触及核心要素或达到最大轮数后揭晓汤底，公布胜者
- 内置「评估进度」功能：AI 评估当前推理进度，若判定玩家已触及真相可直接揭晓

## 功能特性

- **匹配系统**：真人匹配 + 30 秒后 AI 补位提示（可接受 / 继续等待）
- **AI 判定**：基于 LLM（OpenAI / Anthropic / Gemini 三种协议兼容）判定提问
- **AI 玩家**：机器人自动提问，模拟真人玩家
- **进度评估**：主动请求 AI 评估推理进度
- **重回对局**：意外退出后，首页自动检测进行中的对局，一键重回
- **管理后台**：题库管理（增删改查/审核）、AI 供应商/模型/角色配置、数据看板
- **深色模式**：跟随系统或手动切换
- **液态玻璃效果**：可选的高性能玻璃拟态 UI（Cookie 开关）

## 技术架构

```
┌─────────────────────────────────────────────┐
│                  浏览器（前端）               │
│  index / game-play / answer-reveal / admin  │
│  静态文件 + fetch 轮询 + Socket.IO(可选)     │
└──────────────┬──────────────────────────────┘
               │ /soup/ 静态        │ /soup/api/  │ /soup/socket.io/
┌──────────────▼───────────────────▼─────────────▼──────────────┐
│                       Nginx（反向代理）                        │
└──────────────┬────────────────────────────────────────────────┘
               │ http://127.0.0.1:3002
┌──────────────▼────────────────────────────────────────────────┐
│                Node.js 后端（Express + Socket.IO）             │
│  routes/  REST API          services/ 业务逻辑                 │
│  sockets/ Socket.IO         middleware/ 鉴权                   │
└──────┬───────────────────────────────┬────────────────────────┘
       │                               │
┌──────▼──────┐                 ┌──────▼──────┐
│   MySQL 5.7 │                 │ Redis(可选) │
│  turtle_soup│                 │  缓存/降级  │
└─────────────┘                 └─────────────┘
```

- 后端：Node.js ≥ 18 + Express + Socket.IO
- 数据库：MySQL 5.7+（连接池 + 事务）
- 缓存：Redis（可选，未配置自动降级直查 DB）
- 前端：原生 HTML/CSS/JS + Tailwind（CDN）+ Lucide 图标
- 部署：Nginx 托管静态文件并反代 API

## 目录结构

```
turtle-soup-game/
├── public/                        # 前端静态文件（部署到 Nginx 或由后端托管）
│   ├── index.html                 # 匹配大厅（首页）
│   ├── game-play.html             # 对局页
│   ├── answer-reveal.html         # 汤底揭晓页
│   ├── settings.html              # 设置页
│   ├── admin-login.html           # 管理后台登录
│   ├── admin-dashboard.html       # 管理后台看板
│   ├── admin-puzzles.html         # 题库管理
│   ├── admin-ai.html              # AI 配置
│   ├── js/                        # api.js / helpers.js / theme.js / liquid-glass 渲染器
│   ├── css/                       # theme.css
│   └── assets/                    # 图片素材
├── server/                        # 后端
│   ├── src/
│   │   ├── index.js               # 入口：Express + Socket.IO + 静态托管
│   │   ├── config.js              # 环境变量配置 + 启动校验
│   │   ├── db.js                  # MySQL 连接池 + schema 初始化
│   │   ├── redis.js               # Redis 封装（可降级）
│   │   ├── routes/                # REST 路由
│   │   │   ├── userRoutes.js      # 用户注册/资料/揭晓数据
│   │   │   ├── matchRoutes.js     # 匹配（轮询模式）+ 重回对局
│   │   │   ├── gamePollRoutes.js  # 对局轮询/提问/评估
│   │   │   ├── puzzleRoutes.js    # 题目详情
│   │   │   ├── adminRoutes.js     # 管理后台（登录/看板/题库）
│   │   │   └── aiRoutes.js        # AI 供应商/模型/角色管理
│   │   ├── services/
│   │   │   ├── gameService.js     # 对局核心逻辑
│   │   │   ├── matchService.js    # 匹配队列（Socket.IO 模式）
│   │   │   ├── llmService.js      # LLM 判定/评估/机器人提问 + 熔断
│   │   │   ├── aiRouter.js        # 多供应商路由（轮询/故障转移/负载均衡）
│   │   │   ├── aiConfigService.js # AI 配置读取 + 缓存
│   │   │   └── botService.js      # AI 机器人玩家
│   │   ├── sockets/               # Socket.IO 事件
│   │   ├── middleware/            # 用户/管理员鉴权（JWT + token_version）
│   │   └── utils/                 # jwt / crypto(AES-GCM) / prompts
│   ├── seed.js                    # 种子数据（管理员 + 题目）
│   ├── .env.example               # 环境变量模板
│   └── package.json
└── turtle-soup-game.design        # 设计文档
```

## 环境变量

复制 `server/.env.example` 为 `server/.env` 并填写：

| 变量 | 必填 | 说明 |
|------|------|------|
| `PORT` | 否 | 服务端口，默认 3000（生产建议 3002） |
| `JWT_SECRET` | **是** | JWT 签名密钥，长度 ≥ 32，生产必须随机强值 |
| `ADMIN_DEFAULT_PASSWORD` | **是** | 管理员默认口令（seed 时创建），禁止弱口令 |
| `CLIENT_ORIGIN` | 是 | 前端来源（CORS），如 `https://example.com` |
| `MATCH_TIMEOUT_SEC` | 否 | 匹配等待秒数，默认 30 |
| `TURN_TIMER_SEC` | 否 | 每回合倒计时秒数，默认 15 |
| `MAX_ROUNDS` | 否 | 最大轮数，默认 10 |
| `BOT_THINK_MIN_MS` / `BOT_THINK_MAX_MS` | 否 | AI 玩家思考时间范围 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | **是** | MySQL 连接（库名默认 `turtle_soup`） |
| `REDIS_URL` 或 `REDIS_HOST` 等 | 否 | Redis 缓存（可选，缺失自动降级直查 DB） |
| `API_KEY_ENCRYPTION_KEY` | 否 | AI 供应商 API Key 加密密钥（AES-256-GCM，≥16 字符） |

## 部署教程

### 1. 准备依赖

```bash
# Node.js ≥ 18
node -v

# MySQL 5.7+ 并创建数据库
mysql -uroot -p
CREATE DATABASE IF NOT EXISTS turtle_soup DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'turtle'@'127.0.0.1' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON turtle_soup.* TO 'turtle'@'127.0.0.1';
FLUSH PRIVILEGES;

# Redis（可选）
redis-server --daemonize yes
```

### 2. 安装后端依赖

```bash
cd server
npm install
cp .env.example .env
# 编辑 .env：JWT_SECRET / ADMIN_DEFAULT_PASSWORD / DB_* 必填
```

### 3. 初始化数据库

数据库表结构在启动时自动创建（`db.js` 的 `initSchema()`），无需手动建表。

种子数据（管理员 + 示例题目）仅在非生产环境可执行：

```bash
NODE_ENV=development node seed.js
```

> ⚠️ 生产环境执行 `seed.js` 会被拒绝并退出（防止清空线上数据）。

seed 创建的管理员账号：`admin`，口令来自 `.env` 的 `ADMIN_DEFAULT_PASSWORD`。

### 4. 启动后端

```bash
# 前台运行
node src/index.js

# 后台运行
nohup node src/index.js > /tmp/turtle-soup.log 2>&1 &

# 或 systemd（推荐生产）
# 见下方 systemd 示例
```

启动成功日志：

```
[turtle-soup] Server running on port 3002
[turtle-soup] CORS origin: https://你的域名
[turtle-soup] Socket.IO ready
[turtle-soup] Redis: ready   # 或 degraded（直查 DB）
```

### 5. 部署前端

两种方式任选：

**方式 A：Nginx 托管静态文件 + 反代 API（生产推荐）**

前端文件即 `public/` 目录，复制到 Nginx 站点目录：

```bash
cp -r public/* /var/www/turtle-soup/
```

Nginx 配置示例（子路径 `/soup/` 部署）：

```nginx
server {
    listen 80;
    server_name api.example.com;

    # 静态文件
    location ^~ /soup/ {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri.html $uri/ =404;
        location ~* \.html$ {
            add_header Cache-Control "no-cache, must-revalidate";
        }
    }

    # API 反代
    location ^~ /soup/api/ {
        proxy_pass http://127.0.0.1:3002/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Socket.IO 反代（如使用 Socket.IO 模式）
    location ^~ /soup/socket.io/ {
        proxy_pass http://127.0.0.1:3002/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

前端页面里的 API 地址在 HTML 中配置：

```html
<script>window.API_BASE = "/soup/api";</script>
```

**根路径部署**：不想要 `/soup/` 子路径、直接部署在域名根目录时，Nginx 配置改为：

```nginx
server {
    listen 80;
    server_name api.example.com;

    # 静态文件（根路径）
    root /var/www/turtle-soup;
    index index.html;
    location / {
        try_files $uri $uri.html $uri/ =404;
        location ~* \.html$ {
            add_header Cache-Control "no-cache, must-revalidate";
        }
    }

    # API 反代（根路径）
    location /api/ {
        proxy_pass http://127.0.0.1:3002/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Socket.IO 反代
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3002/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

同时把每个 HTML 里的 API 地址改为根路径：

```html
<script>window.API_BASE = "/api";</script>
```

**方式 B：后端直接托管（开发/内网）**

后端已内置静态文件服务（`express.static(public/)`），访问 `http://服务器:3002/` 即可，无需 Nginx。但生产建议用 Nginx（HTTPS、缓存、反向代理）。

### 6. 配置 AI 供应商

AI 判定/机器人提问依赖 LLM，配置方式（二选一）：

1. **管理后台**（推荐）：登录 `admin-login` → 「AI 配置」页面，添加供应商（OpenAI / Anthropic / Gemini 兼容协议）、模型、角色绑定
2. 无 AI 配置时系统自动降级：判定返回「无关」、机器人提问用兜底问题池，游戏仍可运行

> 建议配置 `API_KEY_ENCRYPTION_KEY`，供应商 API Key 会以 AES-256-GCM 加密后落库。

### 7. systemd 服务（推荐生产）

创建 `/etc/systemd/system/turtle-soup.service`：

```ini
[Unit]
Description=Turtle Soup Game Server
After=network.target mysql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/turtle-soup-game/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now turtle-soup
systemctl status turtle-soup          # 查看状态
journalctl -u turtle-soup -f          # 实时日志
```

### 8. 访问与验证

- 用户端：`https://你的域名/soup/`
- 管理后台：`https://你的域名/soup/admin-login`（账号 `admin`）
- 健康检查：`https://你的域名/soup/api/health` → `{"ok":true,"redis":true}`

## 游戏流程

1. **匹配**：首页输入昵称 → 开始匹配；30 秒未满 3 人可接受 AI 补位
2. **对局**：轮流提问，AI 判定「是 / 不是 / 无关」并给出「接近真相」提示
3. **评估**：每轮可请求一次 AI 进度评估，触及真相直接揭晓
4. **揭晓**：连续触及核心要素或达到最大轮数 → 展示汤底、胜者、玩家数据
5. **重回对局**：对局进行中意外退出 → 回首页自动显示「重回对局」按钮

## API 概览

### 用户端

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/users/register` | 注册（昵称，1-16 位中英文/数字/下划线/连字符） |
| POST | `/api/users/logout` | 退出登录（吊销 token） |
| GET | `/api/user/profile` | 个人统计 |
| GET | `/api/user/recent-games` | 最近对局 |
| GET | `/api/game/:id/reveal` | 揭晓数据（仅参与者，防 IDOR） |
| POST | `/api/match/join` | 加入匹配队列（轮询模式） |
| GET | `/api/match/status` | 匹配状态轮询 |
| POST | `/api/match/accept-bots` | 接受 AI 补位 |
| POST | `/api/match/decline-bots` | 拒绝补位继续等待 |
| GET | `/api/match/resume` | 查询可重回的进行中对局 |
| POST | `/api/match/cancel` | 取消匹配 |
| GET | `/api/match/queue-size` | 匹配队列人数（公开） |
| GET | `/api/game/:id/state` | 轮询游戏状态 |
| POST | `/api/game/:id/question` | 提交提问 |
| POST | `/api/game/:id/assess` | 请求进度评估（每轮限一次） |
| GET | `/api/puzzles/:id` | 题目详情（仅汤面） |

### 管理端（需 `admin` 登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/dashboard` | 数据看板 |
| GET/POST | `/api/admin/puzzles` | 题库列表 / 新建 |
| PUT/PATCH/DELETE | `/api/admin/puzzles/:id` | 编辑 / 改状态 / 删除 |
| GET/POST/PUT/DELETE | `/api/admin/ai/providers` | AI 供应商管理 |
| GET/POST/PUT/DELETE | `/api/admin/ai/models` | AI 模型管理 |
| GET/POST/PUT/DELETE | `/api/admin/ai/roles` | AI 角色管理 |
| PUT | `/api/admin/ai/roles/:id/models` | 角色-模型绑定 |
| PATCH | `/api/admin/ai/roles/:id/strategy` | 轮询策略 |
| POST | `/api/admin/ai/test` | 测试模型调用（仅超级管理员） |

### 鉴权

- 用户：`Authorization: Bearer <user_token>`（JWT，1h 过期，登出吊销）
- 管理：Bearer 或 Cookie `admin_token`（15min）
- 限流：全局 API 100 次/分钟；注册/登录/测试模型独立限流

## AI 配置说明

- 支持协议：OpenAI / Anthropic / Gemini
- 轮询策略：`round_robin`（轮询）/ `failover`（故障转移）/ `weighted_random`（加权随机）/ `load_balance`（最小负载）
- 内置角色：
  - `judge`：游戏判定（是/不是/无关 + 是否接近真相）
  - `bot_question`：AI 玩家提问
  - `assessor`：进度评估（管理后台可绑定）
- 连续「接近真相」熔断：同一用户连续 3 次 close_to_truth 强制降级，防作弊刷分

## 常见问题

**Q：启动报 `JWT_SECRET 必须设置且长度>=32`**
.env 未配置或密钥太短，生成随机值：`openssl rand -base64 48`

**Q：启动报 `管理员默认口令过弱`**
`ADMIN_DEFAULT_PASSWORD` 不能是 admin123/admin/123456 等弱口令

**Q：AI 判定全是「无关」**
未配置 AI 供应商或模型调用失败，走了降级逻辑。检查管理后台「AI 配置」和 `/api/admin/ai/test` 测试。

**Q：Redis 报错但不影响启动**
Redis 是可选的，缺失时自动降级直查 DB，日志显示 `degraded`。

**Q：前端 API 404**
`API_BASE` 与 Nginx 反代路径不匹配。子路径部署用 `/soup/api`，根路径用 `/api`。

**Q：改了前端 JS 不生效**
浏览器缓存导致。修改 `api.js` 等公共文件后，记得 bump HTML 里的版本号（如 `api.js?v=3` → `?v=4`）。

## 安全说明

- JWT 密钥、数据库口令、管理员口令生产环境务必使用强随机值
- AI 供应商 API Key 使用 AES-256-GCM 加密存储（配置 `API_KEY_ENCRYPTION_KEY`）
- API 有 SSRF 防护（禁止内网/回环/链路本地地址的 baseUrl）
- 揭晓数据仅参与者可读（防 IDOR）
- 全局限流 + Socket.IO 连接数/事件限流
- 管理后台仅授权管理员访问（登录限流 + token_version 吊销机制）
