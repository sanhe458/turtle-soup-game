# 前端文件迁移到 `public/` 文件夹计划

## 摘要

将散放在 `/workspace` 根目录的全部前端文件（7 个 HTML、`js/`、`assets/`、`.htaccess`）移动到专门的 `public/` 文件夹，使 `public/` 成为新的 Web 根目录。由于所有前端引用都是站点根绝对路径（`/js/...`、`/assets/...`、`/admin-login` 等），把 `public/` 作为新 Web 根后这些路径**完全无需改动**，HTML/JS 零修改。服务端代码无需任何改动（纯 API 服务，不托管静态资源）。

## 当前状态分析（基于探索）

### 根目录下的前端文件（待搬迁）

- HTML（7 个）：`index.html`、`admin-ai.html`、`admin-dashboard.html`、`admin-login.html`、`admin-puzzles.html`、`answer-reveal.html`、`game-play.html`
- JS（3 个）：`js/api.js`、`js/helpers.js`、`js/socket.js`
- 静态资源（3 张图）：`assets/bg-pattern.jpg`（未被任何 HTML 引用，仅设计稿引用）、`assets/game-question-art.jpg`、`assets/hero-illustration.jpg`
- 路由配置：`.htaccess`

### 关键发现

1. **服务端（`server/src/index.js`）是纯 API 服务**：无 `express.static`、无 `res.sendFile`、无 `res.redirect` 到 HTML、无任何 `.html` 引用（已 grep 全 `server/` 目录确认零命中）。前端由 Apache + `.htaccess` 独立托管。
2. **`.htaccess` 实现 clean URL 重写**（`/foo` → `/foo.html`），规则通用，不含具体文件名：
   ```apache
   Options -MultiViews
   RewriteEngine On
   RewriteCond %{REQUEST_FILENAME} -f [OR]
   RewriteCond %{REQUEST_FILENAME} -d
   RewriteRule ^ - [L]
   RewriteCond %{REQUEST_FILENAME}.html -f
   RewriteRule ^(.*)$ /$1.html [L]
   ```
3. **所有前端引用都是站点根绝对路径**，分布于约 30 处：
   - `<script src="/js/api.js">` 等 17 处 script 引用
   - `<img src="/assets/...">` 2 处
   - 跨页 `<a href="/admin-dashboard">` 等 clean URL 约 8 处
   - JS 内 `location.href = '/admin-login'` 等 14 处（`api.js:91` 1 处 + HTML 内联 13 处）
4. **`API_BASE` 与 `SOCKET_BASE` 均为同源相对路径**（`/api` 与空串），与 Web 根位置无关。
5. 设计/校验产物 `turtle-soup-game.design`、`validation-report.json` 是工具元数据，非运行时依赖，留根不动。

### 搬迁决策（已与用户确认）

- 目标文件夹名：`public/`
- 托管方式：`public/` 作为新 Web 根，`.htaccess` 一并移入 `public/`，所有绝对路径无需改动，HTML/JS 零修改。

## 提议变更

### 1. 创建 `public/` 并移动文件

执行如下命令（优先用 `git mv` 保留历史，未纳入 git 跟踪的文件回退到 `mv`）：

```bash
cd /workspace
mkdir -p public

# 移动 7 个 HTML
git mv index.html admin-ai.html admin-dashboard.html admin-login.html \
       admin-puzzles.html answer-reveal.html game-play.html public/

# 移动 js/ 与 assets/ 整个目录
git mv js public/js
git mv assets public/assets

# 移动 .htaccess（Apache 配置随前端一起进 public/，作为新 Web 根）
git mv .htaccess public/.htaccess
```

若某些文件未被 git 跟踪（`git mv` 报错），改用 `mv <src> <dst>`。

### 2. HTML / JS 文件：零改动

由于所有引用都是站点根绝对路径，`public/` 成为新 Web 根后：
- `/js/api.js` → 解析到 `public/js/api.js` ✓
- `/assets/hero-illustration.jpg` → 解析到 `public/assets/hero-illustration.jpg` ✓
- `/admin-login` → `.htaccess` 重写为 `/admin-login.html` → 解析到 `public/admin-login.html` ✓
- `/` → Apache `DirectoryIndex` 指向 `public/index.html` ✓
- `api.js` 中 `location.href = '/admin-login'` → 同上 ✓

**无需对任何 HTML 或 JS 文件做路径改写。**

### 3. 服务端代码：零改动

`server/` 目录完全不涉及静态资源托管，搬迁与后端解耦，无需改动 `server/src/index.js`、`config.js` 或任何路由。

### 4. 留根的文件（不动）

- `/workspace/turtle-soup-game.design` — 设计工具元数据，非运行时依赖。
- `/workspace/validation-report.json` — 一次性校验产物（已过期），非运行时依赖。
- `/workspace/server/` — 后端代码。
- `/workspace/.trae/`、`/workspace/.preflight/` — 工具目录。

## 搬迁后的目标结构

```
/workspace/
├── public/                      ← 新 Web 根
│   ├── .htaccess
│   ├── index.html
│   ├── admin-ai.html
│   ├── admin-dashboard.html
│   ├── admin-login.html
│   ├── admin-puzzles.html
│   ├── answer-reveal.html
│   ├── game-play.html
│   ├── js/
│   │   ├── api.js
│   │   ├── helpers.js
│   │   └── socket.js
│   └── assets/
│       ├── bg-pattern.jpg
│       ├── game-question-art.jpg
│       └── hero-illustration.jpg
├── server/                      ← 不动
├── turtle-soup-game.design      ← 留根
├── validation-report.json       ← 留根
├── .trae/
└── .preflight/
```

## 假设与决策

1. **部署配置由用户自行更新**：搬迁代码后，需将 Apache `DocumentRoot` 指向 `/workspace/public/`（或对应部署路径的 `public/`）。这是部署侧动作，不在代码改动范围内。计划仅完成文件移动，部署配置由用户在部署时调整。
2. **`bg-pattern.jpg` 一并移动**：虽然未被任何 HTML 引用，但它是 `assets/` 目录的一部分，随目录整体搬迁到 `public/assets/`。
3. **设计稿元数据不更新**：`turtle-soup-game.design` 中的 `htmlSrc`/`imageSrc` 字段在搬迁后会变成相对根目录的旧路径（如 `"index.html"` 不再存在）。这是设计工具的元数据，非运行时依赖，不在本次搬迁范围内做适配。如需让设计工具继续定位到文件，可后续手动将这些字段改为 `"public/index.html"` 等。
4. **使用 `git mv` 优先**：保留文件历史；未跟踪文件回退到 `mv`。
5. **不创建任何新文件**：本次仅移动现有文件，不新增 README、不新增配置。

## 验证步骤

1. **结构验证**：
   - `/workspace` 根目录下不再有 `.html` 文件（用 Glob `*.html` 在 `/workspace` 应返回空）。
   - `/workspace` 根目录下不再有 `js/` 和 `assets/` 目录。
   - `/workspace` 根目录下不再有 `.htaccess`。
   - `/workspace/public/` 下包含全部 7 个 HTML + `js/`(3 文件) + `assets/`(3 文件) + `.htaccess`。

2. **引用一致性验证**（确认未引入破损引用）：
   - 在 `public/` 下 Grep `src="/js/`、`src="/assets/`、`location.href = '/` —— 应全部命中且路径仍为站点根绝对路径（与搬迁前一致）。
   - 在 `public/` 下 Grep `\.\/` 或相对路径引用 —— 应无新增（确认无需改写）。

3. **服务端无回归**：
   - Grep `server/` 目录 `sendFile|express\.static|\.html` —— 应零命中（与搬迁前一致，确认后端未受影响）。

4. **运行时验证（需用户配合部署配置）**：
   - 将 Apache `DocumentRoot` 指向 `public/` 后，访问 `/` 应加载首页。
   - 访问 `/admin-login`、`/admin-dashboard` 等 clean URL 应正确重写到对应 `.html`。
   - 浏览器开发者工具确认 `/js/api.js`、`/assets/hero-illustration.jpg` 等 200 返回。
   - 登录、跳转、API 调用、WebSocket 连接功能正常。

## 不在范围内

- 不修改任何 HTML/JS 文件内容。
- 不修改 `server/` 下任何代码。
- 不新增 README 或文档文件。
- 不更新 `turtle-soup-game.design`、`validation-report.json` 的内部字段。
- 不调整 Apache 部署配置（由用户在部署侧完成）。
