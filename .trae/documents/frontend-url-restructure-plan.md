# 前端 URL 结构重构计划

> 目标：将访问路径从 `域名/pages/xxx.html` 改为 `域名/xxx`（无扩展名），清理历史包袱（`-v2` 后缀、内联设计 token、孤儿资源、无根入口），并由 Express 统一托管前端静态资源。

---

## 一、当前状态分析

### 技术栈
- 原生 HTML 多页应用（MPA），无构建步骤、无框架
- Tailwind CSS v4 浏览器端构建版（CDN）+ Lucide Icons + Socket.IO Client
- 后端：Node.js + Express 4.21 + Socket.IO + MySQL + Redis

### 核心问题
| # | 问题 | 现状 |
|---|---|---|
| 1 | URL 带 `pages/` 前缀且带 `.html` 扩展名 | 7 个页面位于 `/workspace/pages/`，访问形如 `domain/pages/match-hall.html` |
| 2 | 两个页面带 `-v2` 版本后缀 | `game-play-v2.html`、`answer-reveal-v2.html`，URL 直接暴露版本号 |
| 3 | 设计 token 在 7 个页面内联复制 | 每个 HTML 的 `<style id="theme-vars">` 逐字复制了 `colors_and_type.css` 的 `:root` 块（约 60 行），改一处需同步 7 处 |
| 4 | 无根 `index.html` 入口 | 访问 `domain/` 落到静态服务器默认行为；用户实际入口为 `match-hall.html` |
| 5 | 孤儿资源 | `/workspace/assets/bg-pattern.jpg` 无任何引用 |
| 6 | 后端不托管静态资源 | Express 无 `express.static`，前端依赖外部静态服务器按目录映射——这正是 `pages/` 前缀的根因 |
| 7 | 前后端文件混放根目录 | 若直接对 `/workspace/` 启用 `express.static` 会暴露 `/workspace/server/` 源码（安全风险） |

### 关键约束
- 页面间跳转使用裸文件名相对路径（`location.href = 'admin-dashboard.html'`），因同处 `pages/` 才生效
- HTML 内引用共享脚本/图片使用 `../js/`、`../assets/` 相对路径——移动目录后将失效
- 服务端 CSP（`server/src/index.js:27-41`）已含 `'self'`，同源托管本地 JS/CSS/图片无需新增域名
- 设计工具导出 `turtle-soup-game.design` 的 `devMetadata.htmlSrc` 字段记录了页面路径

---

## 二、方案决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 重构范围 | 全面重构 | 一次性清除历史包袱 |
| 托管方式 | Express 统一托管 | 消除对外部静态服务器依赖，统一部署 |
| 前端目录 | 新建 `/workspace/public/` 隔离前端 | 避免 `express.static` 暴露 `server/` 源码；标准 Express 模式 |
| URL 扩展名 | 去除 `.html`（`extensions: ['html']`） | 符合现代极简风格，URL 更干净 |
| 主页处理 | `express.static` 的 `index: 'match-hall.html'` | `domain/` 直接服务匹配大厅，无需额外 index.html 或重定向 |
| `-v2` 后缀 | 重命名去除 | `game-play-v2` → `game-play`，`answer-reveal-v2` → `answer-reveal` |
| 设计 token | 抽取到共享 CSS `<link>` | 7 处内联 → 1 处源文件 |

---

## 三、目标目录结构

```
/workspace/
├── public/                      ★ 新建：前端静态资源根（express.static 指向此处）
│   ├── match-hall.html          ← 主页（index 选项指向它）
│   ├── game-play.html           ← 原 game-play-v2.html
│   ├── answer-reveal.html       ← 原 answer-reveal-v2.html
│   ├── admin-login.html
│   ├── admin-dashboard.html
│   ├── admin-puzzles.html
│   ├── admin-ai.html
│   ├── colors_and_type.css      ← 设计 token 源文件（被 <link> 引用）
│   ├── js/
│   │   ├── api.js
│   │   ├── helpers.js
│   │   └── socket.js
│   └── assets/
│       ├── hero-illustration.jpg
│       └── game-question-art.jpg
├── server/                      （不动，源码不再被静态托管暴露）
├── turtle-soup-game.design      （更新 htmlSrc 路径）
└── .trae/                       （不动）
```

> 删除项：`/workspace/pages/`（移空后删除）、`/workspace/assets/bg-pattern.jpg`（孤儿）、根目录原 `js/`、`assets/`、`colors_and_type.css`（迁入 public/）

### 目标 URL 映射

| 文件 | 旧 URL | 新 URL |
|---|---|---|
| match-hall.html | `domain/pages/match-hall.html` | `domain/` 或 `domain/match-hall` |
| game-play.html | `domain/pages/game-play-v2.html` | `domain/game-play` |
| answer-reveal.html | `domain/pages/answer-reveal-v2.html` | `domain/answer-reveal` |
| admin-login.html | `domain/pages/admin-login.html` | `domain/admin-login` |
| admin-dashboard.html | `domain/pages/admin-dashboard.html` | `domain/admin-dashboard` |
| admin-puzzles.html | `domain/pages/admin-puzzles.html` | `domain/admin-puzzles` |
| admin-ai.html | `domain/pages/admin-ai.html` | `domain/admin-ai` |

---

## 四、实施步骤

### 步骤 1：创建 public/ 目录并迁移文件

1. 新建 `/workspace/public/`、`/workspace/public/js/`、`/workspace/public/assets/`
2. 移动并重命名 7 个 HTML：
   - `pages/match-hall.html` → `public/match-hall.html`
   - `pages/game-play-v2.html` → `public/game-play.html`
   - `pages/answer-reveal-v2.html` → `public/answer-reveal.html`
   - `pages/admin-login.html` → `public/admin-login.html`
   - `pages/admin-dashboard.html` → `public/admin-dashboard.html`
   - `pages/admin-puzzles.html` → `public/admin-puzzles.html`
   - `pages/admin-ai.html` → `public/admin-ai.html`
3. 移动共享脚本：`js/*.js` → `public/js/*.js`（3 个文件）
4. 移动图片资源（仅保留被引用的 2 张）：`assets/hero-illustration.jpg`、`assets/game-question-art.jpg` → `public/assets/`
5. 移动设计 token：`colors_and_type.css` → `public/colors_and_type.css`
6. 删除孤儿资源：`/workspace/assets/bg-pattern.jpg`
7. 删除空目录：`/workspace/pages/`、`/workspace/js/`、`/workspace/assets/`

### 步骤 2：修改 7 个 HTML 文件

对每个 HTML 执行以下统一改动（具体行号在实施时定位）：

**(a) 抽取内联设计 token**
- 删除 `<style id="theme-vars">...完整 :root 块...</style>` 整段
- 在 `<head>` 中 Tailwind 脚本之前新增：
  ```html
  <link rel="stylesheet" href="colors_and_type.css">
  ```

**(b) 修复资源相对路径**（因 HTML 与 js/assets/colors_and_type.css 同处 public/ 根）
- `../js/api.js` → `js/api.js`（同理 helpers.js、socket.js）
- `../assets/hero-illustration.jpg` → `assets/hero-illustration.jpg`
- `../assets/game-question-art.jpg` → `assets/game-question-art.jpg`

**(c) 更新跨页面跳转链接**（改为无扩展名 + 新文件名）

| 文件 | 旧引用 | 新引用 |
|---|---|---|
| match-hall.html | `game-play-v2.html?gameId=` | `game-play?gameId=` |
| game-play.html | `answer-reveal-v2.html?gameId=` | `answer-reveal?gameId=` |
| game-play.html | `match-hall.html` | `match-hall`（或 `/`） |
| answer-reveal.html | `match-hall.html` | `match-hall`（或 `/`） |
| admin-login.html | `admin-dashboard.html` | `admin-dashboard` |
| admin-login.html | `match-hall.html` | `match-hall`（或 `/`） |
| admin-dashboard.html | `admin-puzzles.html` / `admin-ai.html` | `admin-puzzles` / `admin-ai` |
| admin-puzzles.html | `admin-dashboard.html` / `admin-ai.html` | `admin-dashboard` / `admin-ai` |
| admin-ai.html | `admin-dashboard.html` / `admin-puzzles.html` | `admin-dashboard` / `admin-puzzles` |

涉及 `<a href>`、`location.href =`、`window.location.href =` 等所有形式。

> 注：保留 `match-hall` 作为链接目标（而非硬编码 `/`），语义清晰且与文件名对应；`/` 由 express.static 的 index 选项兜底。

### 步骤 3：修改 `/workspace/public/js/api.js`

- 第 91 行附近：`location.href = 'admin-login.html'` → `location.href = 'admin-login'`
- 检查 `window.API_BASE`（默认 `/api`）与 `window.SOCKET_BASE`（默认空，同源）——重构后前后端同源，无需改动

### 步骤 4：修改 `/workspace/server/src/index.js`

在 API 路由挂载之后、错误处理中间件之前，新增静态托管：

```js
const path = require('path');
// ...现有代码...

// 前端静态资源托管
app.use(express.static(path.join(__dirname, '../../public'), {
  extensions: ['html'],        // 允许 domain/game-play 访问 game-play.html
  index: 'match-hall.html',    // domain/ 直接服务匹配大厅
  dotfiles: 'ignore',
  // 设置静态资源缓存（生产环境可启用，开发阶段保守）
  maxAge: 0,
}));
```

**位置**：在 `app.use('/api', require('./routes/aiRoutes'));`（第 64 行）之后、Socket.IO setup 之前。

**CSP 复核**：现有 CSP（第 27-41 行）已含 `'self'` 于 `scriptSrc`/`styleSrc`/`fontSrc`/`imgSrc`，本地 JS/CSS/图片同源托管后自动放行，无需修改。CDN 资源（Tailwind/Lucide/Socket.IO/Google Fonts）已在白名单，保持不变。

### 步骤 5：更新设计工具导出 `/workspace/turtle-soup-game.design`

- 将 JSON 中所有 `devMetadata.htmlSrc` 字段的 `pages/xxx.html` 更新为新路径
- 涉及行（据调研）：第 15、32 等处，实施时全文搜索 `pages/` 与 `-v2` 并替换

### 步骤 6：核对预检脚本

- 检查 `/workspace/.preflight/verify_admin_puzzles.py` 是否含 `pages/` URL 断言，若有则同步更新
- 检查 `/workspace/.preflight/` 下其他脚本同理

### 步骤 7：同步文档

- `/workspace/.trae/documents/sea-turtle-soup-backend-plan.md`（第 357、370、380、387 行附近）记录了跳转路径示例，更新为新 URL

---

## 五、假设与决策

1. **保留 Tailwind/Lucide/Socket.IO CDN 引入方式不变**——重构范围仅限目录结构与本地资源，不涉及 CDN 迁移（用户未要求，且改动过大）。
2. **不新增根 `index.html`**——使用 `express.static` 的 `index: 'match-hall.html'` 选项让 `domain/` 直接服务匹配大厅，避免冗余文件与重定向跳转。
3. **跨页链接保留 `match-hall` 而非硬编码 `/`**——语义清晰、与文件名对应、便于维护。
4. **不去除 `.html` 文件扩展名本身**——仅通过 `extensions: ['html']` 让 URL 无扩展名；文件系统保留 `.html` 便于识别。
5. **`colors_and_type.css` 经比对与内联 `<style id="theme-vars">` 内容完全一致**——可直接替换，无需合并差异。
6. **SRI 完整性校验不在本次范围**——属安全审计范畴，用户本次聚焦结构与命名。
7. **保留 `server/` 目录原位不动**——仅前端迁入 `public/`，后端代码与配置不变。

---

## 六、验证步骤

实施完成后依次验证：

1. **目录结构验证**
   - `public/` 下含 7 个 HTML（无 `-v2`）、`colors_and_type.css`、`js/`（3 文件）、`assets/`（2 张图）
   - `/workspace/pages/`、根目录 `js/`、`assets/` 已删除
   - `bg-pattern.jpg` 已删除

2. **启动后端**
   ```bash
   cd /workspace/server && npm start
   ```
   确认无报错，端口正常监听。

3. **URL 访问验证**（浏览器或 curl）
   - `GET /` → 返回 match-hall.html 内容（200）
   - `GET /match-hall` → 200（无扩展名可达）
   - `GET /game-play` → 200
   - `GET /answer-reveal` → 200
   - `GET /admin-login` → 200
   - `GET /admin-dashboard` → 200
   - `GET /admin-puzzles` → 200
   - `GET /admin-ai` → 200
   - `GET /js/api.js` → 200（共享脚本可达）
   - `GET /assets/hero-illustration.jpg` → 200（图片可达）
   - `GET /colors_and_type.css` → 200（设计 token 可达）
   - `GET /pages/match-hall.html` → 404（旧路径已失效，符合预期）
   - `GET /server/src/index.js` → 404（后端源码未被暴露，安全）

4. **页面功能验证**
   - 打开 `domain/`，确认匹配大厅正常渲染（设计 token 生效、玻璃拟态样式正常）
   - 匹配成功后跳转到 `domain/game-play?gameId=xxx`，页面正常
   - 对局结束跳转到 `domain/answer-reveal?gameId=xxx`，页面正常
   - 管理员登录后跳转 `domain/admin-dashboard`，侧边栏导航到 puzzles/ai 正常
   - 401 时自动跳转 `domain/admin-login`

5. **设计 token 单点生效验证**
   - 修改 `public/colors_and_type.css` 中 `--ts-purple` 值
   - 刷新任意页面，确认紫色色调同步变化（证明 `<link>` 生效、内联已移除）

6. **资源加载验证**
   - 浏览器 DevTools Network 面板无 404
   - Console 无 `Failed to load resource` 错误
   - CSP 无违规报告
