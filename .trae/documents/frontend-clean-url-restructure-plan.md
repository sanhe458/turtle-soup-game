# 前端清理与无扩展名 URL 重构计划

## 一、Summary（摘要）

将前端从「`域名/pages/xxx.html`」的旧结构重构为「`域名/xxx`」的干净结构：把 `pages/` 下全部页面移到仓库根目录、修正历史遗留文件名（`match-hall` → `index`、去掉 `-v2` 后缀）、统一资源引用路径、并新增静态服务器重写规则以支持无扩展名访问。同时清理未被引用的冗余资源文件，更新设计源文件与测试脚本中的旧路径。后端（Node/Express）无需改动。

> 用户已确认：`.php` 为笔误，主页为 `index.html`；前端为纯静态部署；其余页面采用无扩展名 `domain/xxx`。

## 二、Current State Analysis（现状分析）

- **页面位置**：全部 7 个 HTML 位于 [pages/](file:///workspace/pages)，访问路径自带 `/pages/` 前缀。
- **资源引用**：页面通过 `../js/*.js`、`../assets/*.jpg`（上行一级）引用根目录的 [js/](file:///workspace/js) 与 [assets/](file:///workspace/assets)。
- **页面间跳转**：使用同级相对路径，如 `match-hall.html`、`game-play-v2.html?gameId=...`、`admin-login.html` 等（见各文件 `location.href` 与 `<a href>`）。
- **历史命名包袱**：`match-hall.html` 实为主页；`game-play-v2.html`、`answer-reveal-v2.html` 残留 `-v2` 后缀（设计定稿后未改名）。
- **冗余资源**：根目录 [colors_and_type.css](file:///workspace/colors_and_type.css) 未被任何 HTML 引用（每个页面已内联相同设计令牌），属散落冗余文件。
- **后端**：[server/src/index.js](file:///workspace/server/src/index.js) 仅挂载 `/api` 路由，不托管静态文件；前端独立部署（`CLIENT_ORIGIN=http://localhost:8080`）。本次重构不涉及后端。
- **静态托管**：仓库内无 nginx/Apache 配置；为支持无扩展名 URL，需提供重写规则。

### 需更新的旧路径引用清单（grep 已确认）
- 页面间：`pages/*.html` 内 7 处 `location.href` 与约 12 处 `<a href="*.html">` 导航链接。
- [js/api.js](file:///workspace/js/api.js#L91) 第 91 行 `location.href = 'admin-login.html'`。
- 设计源 [turtle-soup-game.design](file:///workspace/turtle-soup-game.design) 中 6 处 `"htmlSrc": "pages/xxx.html"`。
- 测试脚本 [.preflight/verify_admin_puzzles.py](file:///workspace/.preflight/verify_admin_puzzles.py#L29) 第 29 行 `http://localhost:8080/pages/admin-puzzles.html`。
- 历史文档 `.trae/documents/*.md`、`.trae/specs/**`、`validation-report.json` 为历史记录/生成产物，**不修改**。

## 三、Target Structure（目标结构）

```
/workspace/
├── index.html              ← 原 pages/match-hall.html（主页，访问 /）
├── game-play.html          ← 原 pages/game-play-v2.html（访问 /game-play）
├── answer-reveal.html      ← 原 pages/answer-reveal-v2.html（访问 /answer-reveal）
├── admin-login.html        ← 原 pages/admin-login.html（访问 /admin-login）
├── admin-dashboard.html    ← 原 pages/admin-dashboard.html（访问 /admin-dashboard）
├── admin-puzzles.html      ← 原 pages/admin-puzzles.html（访问 /admin-puzzles）
├── admin-ai.html           ← 原 pages/admin-ai.html（访问 /admin-ai）
├── .htaccess               ← 新增：Apache 无扩展名重写规则
├── js/                     ← 不动
├── assets/                 ← 不动
├── server/                 ← 不动
└── (pages/ 目录移空后删除)
```

### 文件重命名映射

| 旧路径 | 新路径 | 访问 URL |
|---|---|---|
| `pages/match-hall.html` | `index.html` | `/` |
| `pages/game-play-v2.html` | `game-play.html` | `/game-play` |
| `pages/answer-reveal-v2.html` | `answer-reveal.html` | `/answer-reveal` |
| `pages/admin-login.html` | `admin-login.html` | `/admin-login` |
| `pages/admin-dashboard.html` | `admin-dashboard.html` | `/admin-dashboard` |
| `pages/admin-puzzles.html` | `admin-puzzles.html` | `/admin-puzzles` |
| `pages/admin-ai.html` | `admin-ai.html` | `/admin-ai` |

## 四、Proposed Changes（具体改动）

### 4.1 移动并重命名 7 个页面（git mv 保留历史）
将上表 7 个文件从 `pages/` 移动到根目录并重命名；移动后删除空的 `pages/` 目录。

### 4.2 修正各页面内的资源引用路径
每个页面中：
- `../js/api.js` → `/js/api.js`
- `../js/socket.js` → `/js/socket.js`
- `../js/helpers.js` → `/js/helpers.js`
- `../assets/game-question-art.jpg` → `/assets/game-question-art.jpg`
- `../assets/hero-illustration.jpg` → `/assets/hero-illustration.jpg`

涉及文件：全部 7 个 HTML（`match-hall/game-play-v2/answer-reveal-v2` 各 3 处 script + 部分 img；`admin-*` 各 2 处 script：api.js + helpers.js）。
> 采用根绝对路径 `/js/...`、`/assets/...`，避免无扩展名重写后相对路径解析歧义。

### 4.3 修正页面间跳转链接（统一为根绝对、无扩展名）
| 旧写法 | 新写法 |
|---|---|
| `match-hall.html` | `/` |
| `game-play-v2.html?gameId=X` | `/game-play?gameId=X` |
| `answer-reveal-v2.html?gameId=X` | `/answer-reveal?gameId=X` |
| `admin-login.html` | `/admin-login` |
| `admin-dashboard.html` | `/admin-dashboard` |
| `admin-puzzles.html` | `/admin-puzzles` |
| `admin-ai.html` | `/admin-ai` |

具体落点：
- [index.html](file:///workspace/pages/match-hall.html#L650)（原 match-hall）L650：`game-play-v2.html?gameId=` → `/game-play?gameId=`
- [game-play.html](file:///workspace/pages/game-play-v2.html#L945)（原 game-play-v2）L945：→ `/answer-reveal?gameId=`；L991、L996：`match-hall.html` → `/`
- [answer-reveal.html](file:///workspace/pages/answer-reveal-v2.html#L545)（原 answer-reveal-v2）L545、L548：`match-hall.html` → `/`
- [admin-login.html](file:///workspace/pages/admin-login.html#L275) L275 `<a href="match-hall.html">` → `/`；L341、L408 `admin-dashboard.html` → `/admin-dashboard`
- [admin-dashboard.html](file:///workspace/pages/admin-dashboard.html#L194) L194/200/215/468 导航 `<a href>` → 对应无扩展名；L586/632 `admin-login.html` → `/admin-login`
- [admin-puzzles.html](file:///workspace/pages/admin-puzzles.html#L194) L194/198/210 导航；L535/581 `admin-login.html` → `/admin-login`
- [admin-ai.html](file:///workspace/pages/admin-ai.html#L125) L125/129/141 导航；L261/296 `admin-login.html` → `/admin-login`

### 4.4 修正 [js/api.js](file:///workspace/js/api.js#L91)
L91：`location.href = 'admin-login.html'` → `location.href = '/admin-login'`。

### 4.5 新增 [.htaccess](file:///workspace/.htaccess)（Apache mod_rewrite，纯静态主机即用）
```apache
Options -MultiViews
RewriteEngine On

# 已存在的文件/目录直接放行
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# 无扩展名：/foo -> /foo.html（当 /foo.html 存在时）
RewriteCond %{REQUEST_FILENAME}.html -f
RewriteRule ^(.*)$ /$1.html [L]
```

### 4.6 nginx 配置（仅在用户使用 nginx 时应用，不单独建文件）
在 server 块中加入：
```nginx
location / {
  try_files $uri $uri.html $uri/ =404;
}
```

### 4.7 更新设计源 [turtle-soup-game.design](file:///workspace/turtle-soup-game.design)
将各 `"htmlSrc"` 字段同步为新路径（仅改 `htmlSrc` 值，不动 `id` 等内部标识）：
- `pages/match-hall.html` → `index.html`
- `pages/game-play-v2.html` → `game-play.html`
- `pages/answer-reveal-v2.html` → `answer-reveal.html`
- `pages/admin-dashboard.html` → `admin-dashboard.html`
- `pages/admin-puzzles.html` → `admin-puzzles.html`
- `pages/admin-login.html` → `admin-login.html`
- （若存在 `pages/admin-ai.html` 字段，同样改为 `admin-ai.html`）

### 4.8 更新测试脚本 [.preflight/verify_admin_puzzles.py](file:///workspace/.preflight/verify_admin_puzzles.py#L29)
L29：`http://localhost:8080/pages/admin-puzzles.html` → `http://localhost:8080/admin-puzzles`。

### 4.9 清理冗余资源 [colors_and_type.css](file:///workspace/colors_and_type.css)
该文件未被任何页面引用（令牌已内联于各页 `<style id="theme-vars">`）。执行前再次 grep 确认无引用后删除，消除散落冗余。

## 五、Assumptions & Decisions（假设与决策）

1. **主页扩展名**：`index.html`（用户确认 `.php` 为笔误，纯静态部署）。
2. **URL 形态**：无扩展名 `domain/xxx`，通过服务器重写实现。
3. **重写规则**：默认提供 Apache `.htaccess`（建文件）；nginx 提供 `try_files` 片段（写入本计划，按需应用，不建文件）。开发环境若用 `npx serve`/`http-server`，无扩展名可能不生效，可临时带 `.html` 访问或用支持重写的静态服务器。
4. **路径风格**：资源与跳转统一用根绝对路径（`/js/...`、`/game-play`），保证无扩展名重写下解析稳定。
5. **`-v2` 后缀**：剔除（设计定稿后的历史命名包袱）。
6. **admin 页面**：保持根目录扁平，不再下沉到 `/admin/` 子路径（避免过度设计；如后续需要可再拆）。
7. **后端**：不动。前端 `API_BASE='/api'` 为根相对，不受影响。
8. **历史文档**：`.trae/` 下历史 plan/spec、`validation-report.json` 不修改（属历史记录/生成产物）。
9. **`colors_and_type.css`**：确认无引用后删除（属「资源乱散」清理）。

## 六、Verification Steps（验证步骤）

1. `ls /workspace/pages` 确认目录已删除；根目录存在 7 个新 HTML。
2. `grep -rn "pages/" pages/ 2>/dev/null` 无结果；`grep -rn "\.\./js\|\.\./assets" *.html` 无结果。
3. `grep -rn "match-hall\|game-play-v2\|answer-reveal-v2" *.html js/` 无结果（旧名彻底清除）。
4. 启动静态服务器（支持重写，如 Apache 或配好 try_files 的 nginx），验证：
   - 访问 `/` → 主页（匹配大厅）。
   - 输入昵称开始匹配 → 跳转 `/game-play?gameId=...` 正常。
   - 对局揭晓 → 跳转 `/answer-reveal?gameId=...` 正常。
   - 「返回用户端」/「再来一局」→ 回到 `/`。
   - 访问 `/admin-login` → 登录页；登录后 → `/admin-dashboard`；侧栏切换 `/admin-puzzles`、`/admin-ai` 正常；未授权时被踢回 `/admin-login`。
5. 浏览器 DevTools Network 确认 `/js/api.js`、`/assets/*.jpg` 均 200。
6. 运行 `python .preflight/verify_admin_puzzles.py`（如环境允许）确认管理后台用例通过。
