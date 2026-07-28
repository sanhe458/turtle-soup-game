# 全面安全漏洞修复计划（2026-07）

> 范围：除「JWT 迁移到 HttpOnly Cookie」之外的所有审计发现（Critical / High / Medium / Low）。
> SSRF 采用「完整 DNS 解析 + IP 分类」方案。
> 对 localStorage Token 风险采取「加其他防御」策略（不迁移 Cookie）。

---

## 一、当前状态分析

本次从头审计（后端 + 前端 + 已有审计文档）共确认 **30+ 漏洞**，分布如下：

### 之前已记录但**仍未修复**的 3 个 bug（来自 `security-bug-fixes-remaining.md`）
1. **API Key 写入路径未加密** — [aiRoutes.js:78-81](file:///workspace/server/src/routes/aiRoutes.js#L78-L81) INSERT 与 [aiRoutes.js:101-112](file:///workspace/server/src/routes/aiRoutes.js#L101-L112) UPDATE 直接写入明文 `apiKey`，`encrypt()` 从未被调用。
2. **RBAC 角色值不匹配** — [seed.js:110](file:///workspace/server/seed.js#L110) 写入 `'超级管理员'`，但 [aiRoutes.js:326](file:///workspace/src/routes/aiRoutes.js#L326) `requireRole('superadmin')` 永远 403。
3. **`.env.example` 缺少 `API_KEY_ENCRYPTION_KEY`** — [config.js:20-22](file:///workspace/server/src/config.js#L20-L22) 与 [crypto.js:7-9](file:///workspace/server/src/utils/crypto.js#L7-L9) 依赖它，但 [.env.example](file:///workspace/server/.env.example) 未列出。

### 本次新发现的漏洞

**Critical**
- C-2: SSRF 防护可绕过 — [aiRoutes.js:18-36](file:///workspace/server/src/routes/aiRoutes.js#L18-L36) 仅用字符串正则黑名单，可被 DNS 重绑定 / IP 八进制编码 / IPv6-mapped IPv4 / 尾点绕过。

**High**
- H-1: Socket 鉴权不校验 `token_version` — [matchSocket.js:100-113](file:///workspace/server/src/sockets/matchSocket.js#L100-L113) 只调 `verify(token)`，已注销的 JWT 仍可加入对局。
- H-2: RBAC 实际为扁平模型 — [aiRoutes.js](file:///workspace/server/src/routes/aiRoutes.js) 所有 provider/model/role 增删改只用 `adminAuth`，任何 admin 都能创建 AI 供应商（衔接 C-2 SSRF）。
- H-3: 明文 API Key 缓存到 Redis — [aiConfigService.js:65,138,239](file:///workspace/server/src/services/aiConfigService.js#L65) `decrypt()` 后明文进 Redis，TTL 120s。
- H-FE: Admin JWT 存于 `localStorage` — [api.js:11-59](file:///workspace/js/api.js#L11-L59)，任何用户页 XSS 可窃取 admin token。（本次不迁移 Cookie，加其他防御。）

**Medium（后端）**
- M-1: KEK 派生使用静态盐 — [crypto.js:11](file:///workspace/server/src/utils/crypto.js#L11) `'turtle-soup-salt'` 硬编码。
- M-2: `decrypt()` 静默回退明文 — [crypto.js:25-29](file:///workspace/server/src/utils/crypto.js#L25-L29) `parts.length !== 3` 时原样返回，掩盖 C-1。
- M-3: 单用户多 Socket 多开对局 — [matchService.js:58-66](file:///workspace/server/src/services/matchService.js#L58-L66) 仅按 socketId 查重，按 userId 可双开。
- M-4: 回合超时与 LLM 判定竞态 — [gameService.js:159-167,203-218](file:///workspace/server/src/services/gameService.js#L159-L218) `receiveQuestion` await LLM 期间 `handleTurnTimeout` 可推进 `currentSeat`，await 返回后写入已过期回合。
- M-5: Admin 登录无账户锁定 — [adminRoutes.js:13-19](file:///workspace/server/src/routes/adminRoutes.js#L13-L19) 仅 10次/min/IP，旋转 IP 可在线爆破。
- M-6: 昵称不唯一 — [userRoutes.js:22-40](file:///workspace/server/src/routes/userRoutes.js#L22-L40) 注册前不查重，可冒充。
- M-7: 示例占位符通过启动校验 — [config.js:5-16](file:///workspace/server/src/config.js#L5-L16) `changeme-...` 占位符通过长度检查与弱口令黑名单。
- M-8: CSP `connectSrc` 允许任意 WebSocket — [index.js:35](file:///workspace/server/src/index.js#L35) `['self', 'ws:', 'wss:']`。
- M-9: `trust proxy` 依赖部署拓扑 — [index.js:15](file:///workspace/server/src/index.js#L15) 固定 `1`，无文档/校验。
- M-10: `llmService.userCloseStreak` 无界增长 — [llmService.js:7](file:///workspace/server/src/services/llmService.js#L7) Map 永不清理。
- M-11: 无全局 Socket 连接上限 — [matchSocket.js:10](file:///workspace/server/src/sockets/matchSocket.js#L10) 仅 per-IP 10，分布式可耗尽 200 对局上限。

**Medium（前端）**
- M-FE1: Admin HTML 未鉴权即下发 — [admin-dashboard.html:584-587](file:///workspace/admin-dashboard.html#L584-L587) 等仅前端 JS 跳转，Apache 直接服务静态 HTML，泄漏 admin 表面。
- M-FE2: 静态 HTML 无真实安全响应头 — [.htaccess:1-11](file:///workspace/.htaccess#L1-L11) 仅 rewrite，无 CSP/X-Frame-Options/HSTS/X-Content-Type-Options/Referrer-Policy；`<meta http-equiv="X-Frame-Options">` 不可靠。
- M-FE3: 第三方脚本无 SRI — 所有 `*.html` 的 `<script crossorigin="anonymous">` 缺 `integrity`，HTML 内有 TODO 注释。
- M-FE4: JWT 重复下发到 `match:join` — [index.html:661](file:///workspace/index.html#L661) `{ token: Api.getUserToken() }`，与 `auth` 握手重复，polling 退化时进 POST body。
- M-FE5: `Helpers.el()` + `innerHTML` 模式 — [helpers.js:30-35](file:///workspace/js/helpers.js#L30-L35) 无强制转义；多处数字字段未转义（[admin-dashboard.html:711](file:///workspace/admin-dashboard.html#L711) 等）。
- M-FE6: `window.API_BASE`/`SOCKET_BASE` 未校验 — [api.js:3](file:///workspace/js/api.js#L3)、[socket.js:3](file:///workspace/js/socket.js#L3) DOM clobber 可重定向 fetch/socket 到攻击者主机并携带 Bearer token。

**Low（后端）**
- L-1: JWT 缺 `iss`/`aud`，用户/管理员共享同一 secret — [jwt.js:5-18](file:///workspace/server/src/utils/jwt.js#L5-L18)
- L-2: KEK 最小长度 16 偏弱 — [crypto.js:8-9](file:///workspace/server/src/utils/crypto.js#L8-L9)
- L-3: `config.js` 对缺失 KEK 仅 warn — [config.js:20-22](file:///workspace/server/src/config.js#L20-L22)
- L-4: `req.query.range` 未白名单 — [adminRoutes.js:87,197](file:///workspace/server/src/routes/adminRoutes.js#L87)
- L-5: Admin 题目字段无服务端输出编码 — [adminRoutes.js:231-242,268-273,299-306,319-326](file:///workspace/server/src/routes/adminRoutes.js#L231-L242)
- L-6: `Math.random()` 用于安全相关选择 — [aiRouter.js:53](file:///workspace/server/src/services/aiRouter.js#L53)、[botService.js:12,19](file:///workspace/server/src/services/botService.js#L12)
- L-7: `ORDER BY RAND()` 全表扫描 — [gameService.js:101](file:///workspace/server/src/services/gameService.js#L101)
- L-8: 错误日志含上游响应体前 200 字节 — [aiRouter.js:137,173,213](file:///workspace/server/src/services/aiRouter.js#L137)
- L-9: `CLIENT_ORIGIN='*'` 仅 warn 不阻断 — [index.js:18-20](file:///workspace/server/src/index.js#L18-L20)
- L-11: `/api/health` 公开泄漏 Redis 可用性 — [index.js:56-58](file:///workspace/server/src/index.js#L56-L58)

**Low（前端）**
- L-FE1: `gameId` URL 参数无格式校验 — [game-play.html:618-619](file:///workspace/game-play.html#L618-L619)、[answer-reveal.html:409-410](file:///workspace/answer-reveal.html#L409-L410)
- L-FE2: socket 日志 `socket.id`/`connect_error` — [socket.js:27,30,33](file:///workspace/js/socket.js#L27)
- L-FE3: dev 登录日志 `err.body` — [admin-login.html:411](file:///workspace/admin-login.html#L411)

---

## 二、修复方案

### Phase 1 — Critical 后端修复

#### 1.1 修复 C-1：API Key 写入加密
**文件**：`/workspace/server/src/routes/aiRoutes.js`
- 顶部 `require('../utils/crypto')` 引入 `encrypt`。
- L78-81 INSERT：`apiKey || ''` → `encrypt(apiKey || '')`。
- L95 / L101-112 UPDATE：`newApiKey` 计算时，若 `apiKey` 非空则 `encrypt(apiKey)`；若复用 `existing.apiKey`（已是 decrypt 后明文）则 `encrypt(existing.apiKey)`。
- 验证：写入后 `SELECT api_key FROM ai_providers` 应为 `iv:tag:cipher` 三段 base64。

#### 1.2 修复 C-2：SSRF 完整 DNS 解析 + IP 分类
**新文件**：`/workspace/server/src/utils/ssrfGuard.js`
- 导出 `assertSafeUrl(urlString)`（async，失败抛错）与 `isSafeUrl(urlString)`（async，返回 `{ok, error}`）。
- 逻辑：
  1. `new URL()` 解析，协议必须 `https:`（生产）或 `http:`/`https:`（开发）。
  2. 拒绝用户名/密码中带 `@` 的 URL（避免 `http://evil@127.0.0.1` 绕过）。
  3. 主机名若为 IP 字面量：用 `net.isIP()` 解析，统一转 IPv4 数字或 IPv6 BigInt 后判断是否属于 私有/回环/链路本地/多播/保留 段（覆盖 IPv4 0/8,10/8,127/8,169.254/16,172.16/12,192.168/16,224/4,240/4；IPv6 ::1, fc00::/7, fe80::/10, ff00::/8, ::/8）。同时拒绝八进制/十进制/十六进制 IP 字面量（用 `net.isIP` 判断，非 0 即视为 IP 并按上述判断）。
  4. 主机名若为域名：`dns.promises.lookup(host, { all: true, verbatim: true })` 获取全部 A/AAAA 记录，**任意一条**落入禁段即拒绝。
  5. 主机名若为 `localhost` / `localhost.` / 以 `.` 结尾的裸域名，直接拒绝。
- **每次出站请求前再校验一次**：在 `aiRouter.js` 的 `callOpenAI`/`callAnthropic`/`callGemini`/`testModel` 调用 `fetch` 前，对 `provider.baseUrl` 调 `assertSafeUrl`（防 DNS 重绑定：写入库后到调用之间 IP 可能变化）。
- 删除 [aiRoutes.js:18-36](file:///workspace/server/src/routes/aiRoutes.js#L18-L36) 旧 `validateBaseUrl`，改用 `isSafeUrl`。
- `requireRole('superadmin')` 加到 provider 增删改路由（见 2.2）。

### Phase 2 — High 后端修复

#### 2.1 修复 H-1：Socket 鉴权校验 token_version
**文件**：`/workspace/server/src/middleware/userAuth.js`（提取共享逻辑）、`/workspace/server/src/sockets/matchSocket.js`
- 在 `userAuth.js` 导出 `async verifyUserToken(token)`：`verify(token)` → 查 DB/Redis 的 `token_version` 比对（复用现有 `userAuth` 中间件内的逻辑）。
- `matchSocket.js:106-113` 改为 `const user = await verifyUserToken(token)`，try/catch 处理校验失败。
- 失败时 emit `'error'` 并 `return`，不进 `socketUserMap`。

#### 2.2 修复 H-2：RBAC 角色对齐 + 加权
**文件**：`/workspace/server/seed.js`、`/workspace/server/src/routes/aiRoutes.js`、`/workspace/server/src/db.js`（schema 迁移）
- `seed.js:110` 角色 `'超级管理员'` → `'superadmin'`。
- `db.js` schema：`admins.role` 列注释/默认值若涉及中文角色名，统一为 `superadmin` / `admin` 两档（如已是 VARCHAR 无约束则不动 schema）。
- 在 `aiRoutes.js` 给所有 **写** 路由加 `requireRole('superadmin')`：POST/PUT/DELETE `/admin/ai/providers`、`/admin/ai/models`、`/admin/ai/roles`、`/admin/ai/roles/:id/models`、`PATCH .../strategy`。**读** 路由保持 `adminAuth`。
- 前端 `admin-ai.html` / `admin-puzzles.html` / `admin-dashboard.html` 显示角色处加 `Helpers.adminRoleLabel(role)` 映射（`superadmin` → `超级管理员`），避免界面出现英文。

#### 2.3 修复 H-3：Redis 不缓存明文 API Key
**文件**：`/workspace/server/src/services/aiConfigService.js`
- `getProvider`（L56-72）：缓存对象中 `apiKey` 字段改为存 `r.api_key`（**密文**，原始 DB 值），新增 `apiKeyPlain` 由调用方按需 `decrypt`。
- `getModel`（L114-143）：`provider.apiKey` 改存密文 `r.provider_api_key`。
- `getRoleBindings`（L213-242）：`provider.apiKey` 改存密文 `r.api_key`。
- `aiRouter.js` 调用处：在真正发请求前 `decrypt(provider.apiKey)`（确保 `aiConfigService` 仍 `require crypto`，但缓存层不持有明文）。
- `listProviders` 已用 `maskKey(decrypt(...))`（L47）——保持，但改为 `maskKey(decrypt(r.api_key))`（行为不变，仅注释更新）。
- 验证：`redis.get('ai:provider:<id>')` 返回 JSON 中 `apiKey` 应为 `iv:tag:cipher` 形态。

#### 2.4 缓解 H-FE：localStorage Token 的其他防御
（不迁移 Cookie，按用户选择加其他防御。）
- 见 5.5（API_BASE/SOCKET_BASE 校验）、5.1（.htaccess 真实安全头）、5.4（Trusted Types）、2.2（RBAC 收紧）、Phase 1 SSRF（防止 admin 创建恶意 provider 触发 SSRF 后利用 XSS）。这些组合大幅收窄 XSS→admin token 窃取链路。

### Phase 3 — Medium 后端修复

#### 3.1 M-1：KEK 派生使用每部署随机盐
**文件**：`/workspace/server/src/utils/crypto.js`、`/workspace/server/.env.example`
- 新增 env `API_KEY_SALT`（≥16 字节随机字符串）。
- `getKey()` 改用 `process.env.API_KEY_SALT` 作盐；缺失时回退 `'turtle-soup-salt'` 并 `console.warn`（向后兼容）。
- `.env.example` 添加 `API_KEY_SALT=changeme-generate-16+-bytes-random`。

#### 3.2 M-2：`decrypt()` 静默回退加告警
**文件**：`/workspace/server/src/utils/crypto.js`
- `decrypt` 中 `parts.length !== 3` 分支：`console.warn('[crypto] 检测到明文 API Key，请尽快通过管理后台重新保存以触发加密')`，仍返回明文（向后兼容）。
- 不抛错（避免破坏存量数据读取）。

#### 3.3 M-3：单用户多 Socket 多开对局
**文件**：`/workspace/server/src/services/matchService.js`、`/workspace/server/src/services/gameService.js`
- `gameService` 新增 `getGameByUserId(userId)`：遍历 `activeGames` 检查 `state.players` 是否含该 `userId`。
- `matchService.enqueue`（L58-66）：在按 `socketId`/`userId` 查重后，额外 `if (gameService.getGameByUserId(userId)) return false`。
- 注入：`matchService` 已在 `matchSocket.js` 中 `setHooks`，可直接 `require('../services/gameService')`（注意循环依赖——`gameService` 不 `require matchService`，安全）。

#### 3.4 M-4：回合超时与 LLM 判定竞态
**文件**：`/workspace/server/src/services/gameService.js`
- `receiveQuestion`（L203-218）：在 `await llmService.judgeQuestion(...)`（L236）**之后**、写入 `game_chat`/`state.chat`/`score` 之前，重新校验 `game.state.currentSeat === seat && !game.state.ended && game.state.turnToken === turnToken`（`turnToken` 见下）。
- `receiveQuestion` 入口生成 `const turnToken = ++game.state.turnTokenCounter`（`gameService` 初始化时 `turnTokenCounter: 0`）。
- `handleTurnTimeout`（L332-350）推进 `currentSeat` 时 `++turnTokenCounter`，使任何在途的旧 `turnToken` 失效。
- 校验失败：静默丢弃（仅 `console.warn` 便于排查），不写入、不 emit。

#### 3.5 M-5：Admin 登录账户锁定
**文件**：`/workspace/server/src/routes/adminRoutes.js`
- 新增 `Map<account, {fails, lockedUntil}>` 内存计数器（或 Redis key `ts:admin:fail:<account>`）。
- `loginLimiter` 之后：登录失败时 `fails++`；连续 5 次失败锁定 15 分钟（`lockedUntil = now + 15min`），期间直接返回 429 `{error:'账户已锁定，请 15 分钟后重试'}`。
- 登录成功清零。
- 失败计数同时仍受 IP 限流保护。

#### 3.6 M-6：昵称唯一性
**文件**：`/workspace/server/src/routes/userRoutes.js`、`/workspace/server/src/db.js`（schema）
- `users.nickname` 加 `UNIQUE` 索引（MySQL 5.7：`ALTER TABLE users ADD UNIQUE INDEX uk_nickname (nickname)`，注意 utf8mb4 限 VARCHAR(191)）。
- `userRoutes.js:22-40` 注册前 `SELECT id FROM users WHERE nickname = ?`，存在则 409 `{error:'昵称已被占用'}`。
- 由于用户无密码/无邮箱，登录即注册流程改为：输入昵称 → 若存在则提示「该昵称已存在，请更换或使用原账号」。

#### 3.7 M-7：示例占位符检测
**文件**：`/workspace/server/src/config.js`
- 新增 `PLACEHOLDER_PATTERNS = [/^changeme/i, /generate.*strong/i, /please.*replace/i, /your-.*-here/i]`。
- `JWT_SECRET` 校验：除长度外，若匹配 placeholder 模式则 `process.exit(1)`。
- `ADMIN_DEFAULT_PASSWORD` 校验：除弱口令黑名单外，匹配 placeholder 也退出。
- `DB_PASSWORD` 同样校验。
- `.env.example` 顶部加红字注释「以下占位符仅示例，部署前必须替换为真实随机值；启动会校验占位符并拒绝启动」。

#### 3.8 M-8：CSP `connectSrc` 收紧
**文件**：`/workspace/server/src/index.js`
- L35 `connectSrc: ["'self'", 'ws:', 'wss:']` → `connectSrc: ["'self'", 'wss:' + originHost]`，其中 `originHost` 取自 `config.clientOrigin`（如 `wss://localhost:8080`）。生产环境从 `CLIENT_ORIGIN` 推导同源 wss；开发环境额外允许 `ws://localhost:3000`（本机 socket）。
- 实现：`const wsOrigin = config.clientOrigin.replace(/^http/, 'ws');` → `connectSrc: ["'self'", wsOrigin]`。

#### 3.9 M-9：`trust proxy` 文档化
**文件**：`/workspace/server/src/index.js`、`/workspace/server/.env.example`
- 新增 env `TRUST_PROXY_HOPS`（默认 `1`）。
- `app.set('trust proxy', config.trustProxyHops)`，`config.js` 读取并校验为非负整数。
- `.env.example` 注释说明：「直连设 0；单层反向代理设 1；多层设对应层数」。

#### 3.10 M-10：`llmService.userCloseStreak` 清理
**文件**：`/workspace/server/src/services/llmService.js`
- `Map` 改为 `LRU` 或定时清理：每 5 分钟 `setInterval` 遍历，删除 `lastSeen` 超过 1 小时的条目。
- 或简单方案：每次写入时检查 `size > 10000`，超限清空最旧一半（按 `lastSeen` 排序）。
- 记录结构改为 `{ count, lastSeen: Date.now() }`。

#### 3.11 M-11：全局 Socket 连接上限 + 队列上限
**文件**：`/workspace/server/src/sockets/matchSocket.js`、`/workspace/server/src/services/matchService.js`
- `matchSocket.js`：新增 `MAX_TOTAL_CONNECTIONS = 1000`，`io.on('connection')` 入口 `if (io.engine.clientsCount > MAX_TOTAL_CONNECTIONS) { socket.disconnect(true); return; }`。
- `matchService.js:58-66` `enqueue`：`if (queue.length >= MAX_QUEUE_SIZE) return false`，`MAX_QUEUE_SIZE = 500`。
- 超限返回 `{error:'服务器繁忙，请稍后再试'}`。

### Phase 4 — Low 后端修复

#### 4.1 L-1：JWT 加 `iss`/`aud`，用户/管理员分离
**文件**：`/workspace/server/src/utils/jwt.js`
- `sign(payload)` 默认注入 `iss: 'turtle-soup'`, `aud: payload.type === 'admin' ? 'turtle-soup-admin' : 'turtle-soup-user'`。
- `verify(token)` 校验 `aud`（用 `jsonwebtoken` 的 `audience` 选项），不匹配抛错。
- 仍共用 secret（分离 secret 需要迁移存量 token，暂不做）。

#### 4.2 L-2：KEK 最小长度 32
**文件**：`/workspace/server/src/utils/crypto.js`、`/workspace/server/src/config.js`
- `getKey()` 与 `config.js` 的 `length < 16` → `length < 32`。
- `config.js` 改为 `process.exit(1)`（与 L-3 合并）。

#### 4.3 L-3：`config.js` 缺失 KEK 退出
**文件**：`/workspace/server/src/config.js`
- L20-22 `console.warn` → `console.error` + `process.exit(1)`。
- 与 4.2 合并：KEK 缺失或 < 32 字节均退出。

#### 4.4 L-4：`req.query.range` 白名单
**文件**：`/workspace/server/src/routes/adminRoutes.js`
- L87 附近：`const VALID_RANGES = ['today','7d','30d']; const range = VALID_RANGES.includes(req.query.range) ? req.query.range : '7d';`

#### 4.5 L-5：Admin 题目字段服务端输出编码
**文件**：`/workspace/server/src/routes/adminRoutes.js`
- 新增 `function sanitizeText(s){ return typeof s==='string' ? s.replace(/[<>]/g, '') : s; }`（仅去除尖括号，前端已 `escape`，此为纵深防御）。
- 在题目列表/详情响应中 `title/scenario/truth` 经 `sanitizeText`。

#### 4.6 L-6：`crypto.randomInt` 替换 `Math.random`
**文件**：`/workspace/server/src/services/aiRouter.js`、`/workspace/server/src/services/botService.js`
- `aiRouter.js:53` 加权随机：`Math.random()` → `crypto.randomInt(0, 1000) / 1000`。
- `botService.js:12,19` 同理。

#### 4.7 L-7：`ORDER BY RAND()` 优化
**文件**：`/workspace/server/src/services/gameService.js`
- `gameService.js:101` 改为：先 `SELECT COUNT(*) FROM puzzles WHERE status='online'`，再 `SELECT * FROM puzzles WHERE status='online' LIMIT 1 OFFSET <rand(0,count-1)>`，`<rand>` 用 `crypto.randomInt(0, count)`。
- 避免 `ORDER BY RAND()` 全表扫描。

#### 4.8 L-8：错误日志脱敏
**文件**：`/workspace/server/src/services/aiRouter.js`
- L137/173/213 `errText.slice(0, 200)` → 不再嵌入 `errText`，仅记录 `上游 HTTP {status}` 与 `errText` 的长度/前 50 字符（且 `replace(/sk-[A-Za-z0-9]+/g, 'sk-***')` 脱敏）。

#### 4.9 L-9：`CLIENT_ORIGIN='*'` 硬阻断
**文件**：`/workspace/server/src/index.js`
- L18-20 `console.warn` → `console.error` + `process.exit(1)`，要求显式 origin。

#### 4.10 L-11：`/api/health` 收紧
**文件**：`/workspace/server/src/index.js`
- L56-58 `/api/health` 改为只返回 `{ok:true, time}`，移除 `redis: redis.isAvailable()`（避免 Recon）。
- 或加 `adminAuth` 保护（但健康检查通常无鉴权，倾向移除 redis 字段）。

### Phase 5 — 前端修复（不含 Cookie 迁移）

#### 5.1 M-FE2：`.htaccess` 添加真实安全响应头
**文件**：`/workspace/.htaccess`
- 追加：
  ```apache
  Header always set X-Frame-Options "DENY"
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "no-referrer"
  Header always set Strict-Transport-Security "max-age=63072000; includeSubDomains"
  Header always set Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdn.socket.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'; base-uri 'self';"
  ```
  （`script-src` 含 `'unsafe-inline'` 因内联脚本未外置，权衡后保留；`connect-src` 的 `wss:/ws:` 与 3.8 后端 CSP 一致。）
- 删除各 HTML 的 `<meta http-equiv="X-Frame-Options">`（已被真实头覆盖，保留无害但冗余）——可选，保留亦可。

#### 5.2 M-FE3：第三方脚本加 SRI
**文件**：所有 `*.html`
- 用 `curl <url> | openssl dgst -sha384 -binary | openssl base64 -A` 计算每个外部 `<script src>` 与 `<link href>` 的 `integrity="sha384-<hash>"`。
- 涉及资源：
  - `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.1/dist/index.global.js`
  - `https://unpkg.com/lucide@1.8.0/dist/umd/lucide.min.js`
  - `https://cdn.socket.io/4.8.1/socket.io.esm.min.js`（如使用）
  - Google Fonts CSS（`fonts.googleapis.com`）——CSS 可加 SRI。
- 删除 `<!-- TODO: compute and add integrity ... -->` 注释。

#### 5.3 M-FE4：移除 `match:join` 重复 token
**文件**：`/workspace/index.html`
- L661 `socket.emit('match:join', { token: Api.getUserToken() })` → `socket.emit('match:join', {})`。
- 后端 `matchSocket.js:100` 已通过 `socket.handshake.auth.token` 拿 token——**但当前实现是从 payload 取**。需同步改 `matchSocket.js`：改用 `socket.handshake.auth.token`。
- `socket.js:13-25` `io(SOCKET_BASE, { auth: { token } })` 保持。

#### 5.4 M-FE5：Trusted Types 策略
**文件**：`/workspace/js/helpers.js`
- 顶部创建策略：
  ```js
  const ttPolicy = window.trustedTypes ? window.trustedTypes.createPolicy('tsHtml', { createHTML: (s) => s }) : null;
  ```
- `el(html)`：`template.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html.trim();`
- `.htaccess` CSP `script-src` 追加 `trusted-types tsHtml`（不加 `require-trusted-types-for 'script'`，避免破坏内联脚本直接 innerHTML）。
- 注：此为渐进式引入，仅 `Helpers.el` 走策略；其他直接 `innerHTML` 暂不受强制。完整 enforcement 需内联脚本外置+nonce，本次不做。

#### 5.5 M-FE6：校验 `API_BASE`/`SOCKET_BASE`
**文件**：`/workspace/js/api.js`、`/workspace/js/socket.js`
- `api.js:3`：
  ```js
  const API_BASE = (typeof window.API_BASE === 'string' && (window.API_BASE.startsWith('/') || window.API_BASE.startsWith(location.origin)))
    ? window.API_BASE : '/api';
  ```
- `socket.js:3` 同理：`SOCKET_BASE` 必须为空字符串、相对路径、或同源 URL。
- 防止 DOM clobber（`<a id="API_BASE">`）重定向。

#### 5.6 M-FE1：Admin HTML 服务端鉴权
**文件**：`/workspace/server/src/index.js`（或新增路由）
- 思路：让 Express 接管 `admin-*.html` 的下发，在发送前校验 admin token（cookie/header）。
- 实现：
  - 新增 `app.get(['/admin-login.html','/admin-dashboard.html','/admin-ai.html','/admin-puzzles.html'], (req,res,next) => { ... })`，对非 `admin-login.html` 路径，从 `Authorization` header 或 `?token=` 读取 admin token 并 `verify`；失败则 `res.redirect('/admin-login')`。`admin-login.html` 直接放行。
  - `.htaccess` 增加 `RewriteRule ^admin-(login|dashboard|ai|puzzles)$ - [L]`（不 rewrite 给 Apache 静态），或改为反向代理到 Express。
  - **权衡**：当前架构 Apache 直接服务静态 HTML，Express 仅处理 `/api`。若改为 Express 服务 admin HTML，需要调整 `.htaccess` 把这些路径 proxy 给 Express。**备选更简方案**：Apache 用 `[E=...]` + 环境变量不可行（Apache 无法验 JWT）。**最终采用**：`.htaccess` 把 `admin-dashboard`/`admin-ai`/`admin-puzzles` 的请求 rewrite 到 Express 一个新路由 `GET /api/admin/html/:page`，Express 验证 token 后用 `res.sendFile` 返回对应 HTML；`admin-login` 仍由 Apache 直接服务。
  - 前端 admin 页 JS 不变（仍从 localStorage 取 token，但页面本身需带 token 才能下载——通过 `?token=` 临时参数或改为登录后由 Express set 短期 cookie 标记「可访问 admin HTML 5 分钟」）。**为避免引入 cookie，采用**：admin 页之间跳转时 URL 带 `?t=<token>`，Express 路由校验后 `sendFile` 并立即从 HTML 中剥离 `?t`（前端 JS `history.replaceState` 清理 URL）。**更简方案**：接受 admin HTML 可被未鉴权下载（信息泄漏有限——无数据、无密钥），仅作为 Low 风险记录，**本次不实现服务端鉴权**，转而通过 5.1 真实安全头 + 5.2 SRI + 2.2 RBAC 收窄攻击面。
  - **决策**：M-FE1 降级为「已知 Low 风险，本次不修」，在 `security-bug-fixes-remaining.md` 记录。原因：当前架构 Apache+Express 分离，强行让 Express 服务 admin HTML 需引入 token-in-URL 或 cookie，前者比信息泄漏更危险，后者与「暂不迁移 Cookie」冲突。

#### 5.7 L-FE1：`gameId` UUID 格式校验
**文件**：`/workspace/game-play.html`、`/workspace/answer-reveal.html`
- `const expectedGameId = params.get('gameId') || '';` 后加 `if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedGameId)) { location.href='/'; return; }`。

#### 5.8 L-FE2：移除 socket 日志
**文件**：`/workspace/js/socket.js`
- L27 `console.log('[socket] 已连接', socket.id)` → 删除。
- L30 `console.log('[socket] 已断开', reason)` → 删除。
- L33 `console.warn('[socket] 连接错误', err.message)` → 保留为 `console.warn('[socket] 连接错误')`（不输出 `err.message`，避免泄漏服务端鉴权错误细节）。

#### 5.9 L-FE3：移除 dev 登录 `err.body` 日志
**文件**：`/workspace/admin-login.html`
- L411 `console.error('[admin login] 失败:', err)` → `console.error('[admin login] 失败')`（不输出 err 对象，避免 `err.body` 泄漏服务端响应）。

#### 5.10 数字字段转义（纵深防御）
**文件**：`/workspace/admin-dashboard.html`、`/workspace/admin-ai.html`、`/workspace/admin-puzzles.html`、`/workspace/answer-reveal.html`
- 对所有 `(g.rounds||0)`、`(p.playCount)`、`(p.rating)`、`(c.value)`、`(m.contextWindow/1000)` 等数字插值，用 `Helpers.escape(String(...))` 包裹。
- 虽然当前是数字，未来字段类型变更时不致 XSS。

### Phase 6 — 配置与文档

#### 6.1 `.env.example` 补全
**文件**：`/workspace/server/.env.example`
- 新增：
  ```
  # API Key 加密 KEK（必须设置 ≥32 字符随机串；缺失或过短将拒绝启动）
  API_KEY_ENCRYPTION_KEY=changeme-generate-a-strong-kek-of-at-least-32-chars
  # API Key 加密盐（推荐设置 ≥16 字节随机串；未设置则回退内置盐并告警）
  API_KEY_SALT=changeme-generate-16+-bytes-random
  # 反向代理跳数（直连=0，单层代理=1，多层=对应层数）
  TRUST_PROXY_HOPS=1
  ```
- `JWT_SECRET` / `ADMIN_DEFAULT_PASSWORD` / `DB_PASSWORD` 行注释加红字「启动会检测 changeme 等占位符并拒绝启动」。

#### 6.2 更新 `security-bug-fixes-remaining.md`
**文件**：`/workspace/.trae/documents/security-bug-fixes-remaining.md`
- 标记 3 个 remaining bug 为已修复。
- 追加本次新发现 + 修复清单（引用本计划文件）。
- 记录 M-FE1（admin HTML 未鉴权）为「已知 Low 风险，待 Cookie 迁移时一并解决」。
- 记录「内联脚本外置 + nonce 严格 CSP」为「已知 Medium 风险，待后续重构」。

---

## 三、假设与决策

1. **不迁移 HttpOnly Cookie**（用户选择）：admin JWT 仍在 localStorage，靠 5.1/5.2/5.4/5.5/2.2 收窄 XSS→token 链路。完整根治留待后续 Cookie 迁移。
2. **SSRF 用完整 DNS 解析**（用户选择）：每次出站请求前都解析 + IP 分类，防 DNS 重绑定。
3. **不强制 Trusted Types enforcement**：仅创建策略供 `Helpers.el` 使用，不加 `require-trusted-types-for 'script'`（会破坏内联脚本）。完整 enforcement 待内联脚本外置。
4. **静态 HTML CSP 含 `'unsafe-inline'`**：因内联脚本未外置，权衡后保留；其他指令严格。
5. **M-FE1（admin HTML 未鉴权）本次不修**：架构所限，强行修需引入 token-in-URL（更危险）或 cookie（与不迁移决策冲突）。降级为已知 Low 风险。
6. **MySQL 5.7 约束**：所有 schema 改动遵守 VARCHAR(191) 索引限制、无 CHECK、`?` 占位符。
7. **Redis 可选**：所有 Redis 依赖路径保持降级到 DB。
8. **不写历史数据迁移脚本**：项目在 seed 驱动开发期，无真实数据；`decrypt()` 向后兼容明文透传 + 3.2 告警，重新保存即触发加密。
9. **不引入 zod/ajv socket schema 校验**：保持 prior 决策，靠连接上限 + 事件限流。
10. **角色值统一为英文** `superadmin`/`admin`：seed 与 JWT 一致，前端用 `adminRoleLabel` 映射显示。

---

## 四、验证步骤

### 后端验证
1. `cd server && npm test`（如有测试）；若无，手动：
   - `node seed.js` 重置数据，确认 admin 角色 `superadmin`。
   - 启动 server，用弱/占位 `.env` 启动应退出。
   - 登录 admin，创建 provider 带 apiKey，`SELECT api_key FROM ai_providers` 应为三段 base64。
   - `redis.get('ai:provider:<id>')` 中 `apiKey` 应为密文。
   - 创建 provider 指向 `http://127.0.0.1` 应被拒；指向 `http://attacker.example`（DNS 解析到 127.0.0.1）应被拒。
   - 登出 user 后用旧 token `match:join` 应被拒。
   - 同一 user 两 tab `match:join` 第二个应被拒。
   - `/api/admin/ai/test` 用 `superadmin` 角色应 200（不再 403）。
   - 普通管理员（role=`admin`）POST `/admin/ai/providers` 应 403。

### 前端验证
1. 浏览器 DevTools Network：静态 HTML 响应头应含 `X-Frame-Options: DENY`、`Content-Security-Policy`、`Strict-Transport-Security`、`X-Content-Type-Options`、`Referrer-Policy`。
2. 外部 `<script>` 标签应有 `integrity="sha384-..."`；篡改 CDN 内容应被浏览器拒绝。
3. `match:join` payload 不再含 `token`。
4. 控制台无 `socket.id` 日志。
5. `/game-play?gameId=abc` 应跳转首页。
6. DOM clobber 测试：`<a id="API_BASE" href="https://evil/">` 后 `Api.get('/foo')` 仍请求 `/api/foo`。

### 回归
- 现有功能（注册/登录/匹配/对局/AI 判定/admin CRUD）全流程冒烟。

---

## 五、实施顺序建议

1. Phase 6.1（.env.example 补全）+ Phase 1（Critical）—— 立即收口最严重风险。
2. Phase 2（High）—— RBAC + Socket 鉴权 + Redis 明文。
3. Phase 3（Medium 后端）—— 逐项修。
4. Phase 4（Low 后端）—— 批量修。
5. Phase 5（前端）—— .htaccess + SRI + Trusted Types + API_BASE 校验 + 移除冗余 token + 日志清理 + 数字转义。
6. Phase 6.2（文档更新）。

每完成一个 Phase 跑一次冒烟，避免回归堆积。
