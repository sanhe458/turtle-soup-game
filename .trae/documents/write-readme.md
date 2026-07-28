# 计划：编写 README.md（项目简介 + 详细部署教程）

## 摘要
在仓库根目录 `/workspace/README.md` 创建一份新文件：前半部分用简短几段介绍项目（是什么、技术栈、核心功能、目录结构），后半部分给出从零到可访问的详细部署教程。README 用中文编写，与项目现有文档（`server/.env.example`、`.trae/documents/*` 均为中文）保持一致。

## 当前状态分析
- 仓库**目前没有任何 README**（根目录、`server/` 下都没有）。
- 项目是一个**海龟汤实时多人对战游戏**：前端为 6 个静态 HTML 页面（CDN 版 Tailwind v4 + 原生 JS，位于 `/workspace/pages/` 与 `/workspace/js/`），后端为 Node.js 服务（位于 `/workspace/server/`，Express 4 + Socket.IO 4.8 + MySQL 5.7 + 可选 Redis，CommonJS，入口 `server/src/index.js`）。
- **无 Dockerfile / docker-compose / CI 配置**，部署教程需基于裸机/进程管理器方式编写。
- 关键事实（来自实际读取文件，将写入教程）：
  - `server/package.json`：`engines.node >= 18`；脚本 `start`/`dev`/`seed`；入口 `src/index.js`。
  - `server/seed.js`：在 `NODE_ENV=production` 下**直接退出拒绝执行**（第 7-10 行）；初始化管理员账号为 `account='admin'`，密码取自 `ADMIN_DEFAULT_PASSWORD` 环境变量（第 105-111 行）；同时写入 6 道内置题目。
  - `server/.env.example`：列出全部环境变量及中文注释（PORT、JWT_SECRET、ADMIN_DEFAULT_PASSWORD、CLIENT_ORIGIN、游戏配置、MySQL、Redis）。
  - `server/src/config.js`（经搜索代理确认）：`JWT_SECRET` 必须 ≥32 字符、`ADMIN_DEFAULT_PASSWORD` 不得为弱口令，否则启动直接退出；`API_KEY_ENCRYPTION_KEY` ≥16 字符（缺失时启动告警、运行时加解密抛错）。
  - AI 供应商/模型/角色**不通过环境变量配置**，而是在管理后台「AI 配置」页面维护（`.env.example` 第 8 行明确声明）。
  - 前端无构建步骤，需单独用静态服务器托管（如 `npx serve .` 监听 8080），后端通过 `CLIENT_ORIGIN` 做 CORS。
  - 前端 `js/api.js` 默认 `API_BASE='/api'`，可用 `window.API_BASE` 覆盖 → 生产需经反向代理把 `/api` 与 `/socket.io` 转发到后端。

## 拟定改动

### 文件：`/workspace/README.md`（新建）
唯一改动文件。内容结构如下：

#### 1. 标题与一句话简介
`# 海龟汤游戏` + 一句话：基于 Express + Socket.IO 的海龟汤实时多人对战游戏，支持真人/AI 混合匹配与 LLM 担任裁判。

#### 2. 项目简介（简短）
- **玩法**：3 人房，1 名主持人知「汤底」，其余玩家提问推理「汤面」；15 秒/回合，最多 10 回合。
- **核心特性**（4-6 条要点）：匿名昵称登录(JWT)、混合匹配(30s 超时可引入 AI Bot)、LLM 裁判(是/不是/无关 + 接近真相检测)、管理后台(KPI 看板 + 题库 CRUD + AI 供应商/模型/角色配置)、多供应商路由(轮询/故障转移/加权/负载均衡)、AES-256-GCM 加密 API Key。
- **技术栈**：后端 Node.js ≥18 / Express 4 / Socket.IO 4.8 / MySQL 5.7 / 可选 Redis；前端原生 HTML+JS + Tailwind v4(CDN)。
- **目录结构**：一段精简树形图（`server/`、`pages/`、`js/`、`assets/` 及关键子项）。

#### 3. 详细部署教程
按顺序分小节，每节给出可直接复制的命令：

**3.1 环境要求**
- Node.js ≥ 18
- MySQL 5.7
- Redis（可选，未配置自动降级直查 DB）
- 任意静态文件服务器（前端用，如 `serve` / Nginx）

**3.2 后端部署**
```bash
cd server
npm install
cp .env.example .env
# 编辑 .env，至少修改 JWT_SECRET / ADMIN_DEFAULT_PASSWORD / DB_* （见 3.5）
npm run seed      # 初始化表结构 + 管理员账号 + 6 道题目（NODE_ENV=production 下会拒绝执行）
npm start         # 默认监听 PORT=3000
# 健康检查：curl http://localhost:3000/api/health
```
说明：管理员账号为 `admin`，密码 = `.env` 中 `ADMIN_DEFAULT_PASSWORD` 的值。

**3.3 前端部署**
```bash
# 在仓库根目录
npx serve . -l 8080
```
说明：前端为纯静态文件，无构建步骤；需保证 `CLIENT_ORIGIN` 与前端实际访问地址一致（CORS）。
生产环境推荐用 Nginx 托管 `/workspace` 根目录静态文件，并将 `/api`、`/socket.io` 反向代理到后端（给出 Nginx location 示例片段）。

**3.4 首次配置 AI（管理后台）**
1. 访问 `pages/admin-login.html`，用 `admin` + `ADMIN_DEFAULT_PASSWORD` 登录。
2. 进入「AI 配置」：依次创建供应商 → 模型 → 角色 → 角色绑定模型，并启用。
3. AI 配置存于数据库，**不**通过环境变量。

**3.5 环境变量参考**
用表格列出 `.env.example` 中全部变量：变量名 | 必填 | 默认值 | 说明。必填项标注 `JWT_SECRET`、`ADMIN_DEFAULT_PASSWORD`、`DB_USER`、`DB_PASSWORD`；并补充 `API_KEY_ENCRYPTION_KEY`（配置 AI 时必需，≥16 字符）。

**3.6 生产环境注意事项**
- 设置 `NODE_ENV=production`（注意：此时 `npm run seed` 会被禁，需在首次部署、未切生产前完成 seed，或临时unset后seed再切回）。
- `JWT_SECRET`、`ADMIN_DEFAULT_PASSWORD`、`API_KEY_ENCRYPTION_KEY`、`DB_PASSWORD` 必须替换为强随机值。
- 用进程管理器守护后端（PM2 示例：`pm2 start src/index.js --name turtle-soup`）。
- 启用 Redis 以支持多实例横向扩展（Socket.IO Redis adapter）。
- 反向代理需传递 `X-Forwarded-*`（后端已设 `trust proxy`）。

## 假设与决策
- **语言**：README 全文用中文（项目所有既有文档均为中文，且用户指令为中文）。
- **不引入 Docker**：仓库现无容器化文件，教程按裸机/PM2/Nginx 方式写，与现状一致，避免臆造未实现的部署方式。
- **不新增任何其他文件**：仅创建 `/workspace/README.md`，不改动 `.env.example`、代码或目录。
- **命令可直接复制**：所有 shell 命令基于实际 `package.json` scripts 与 `.env.example`，不杜撰。
- **遵循用户设计语言**：README 仅为 Markdown 文档，无 UI；用户规则中的玻璃拟态/配色等设计要求适用于前端页面，本任务不涉及，故不强行套用。

## 验证步骤
1. 确认 `/workspace/README.md` 已创建且仅此一个文件被新增（`git status`）。
2. 通读 README，核对：
   - 命令与 `server/package.json` 的 `scripts` 一致（`start`/`dev`/`seed`）。
   - 环境变量表与 `server/.env.example` 完全对应，无遗漏、无臆造。
   - 管理员账号名 `admin` 与 `seed.js` 第 110 行一致。
   - `NODE_ENV=production` 禁 seed 的说明与 `seed.js` 第 7-10 行一致。
3. （可选）按教程在本地空目录试跑后端 `npm install && npm run seed && npm start`，确认 `/api/health` 返回 200。
