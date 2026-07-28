# 引入 Redis 用于缓存 — 实施计划

## Summary

为「海龟汤」后端服务引入 Redis 作为可选缓存层，覆盖两类核心高频读路径：
1. **JWT 鉴权** — 缓存 `users` / `admins` 的 `token_version`，消除每个鉴权请求一次 DB 查询
2. **AI 配置** — 缓存 `aiConfigService` 的 providers / models / roles / bindings 读取，消除 AI 判定时的多表 JOIN

同时启用 **Socket.IO Redis 适配器**，为后续多实例水平扩展铺路。

Redis 为**可选依赖**：未配置或不可用时自动降级直查 DB，不阻断服务启动，不抛错给上层。

## Current State Analysis

当前架构（基于 [server/src/index.js](file:///workspace/server/src/index.js)）：

- **鉴权链路**：每个受保护请求都走 [userAuth.js](file:///workspace/server/src/middleware/userAuth.js#L15-L18) / [adminAuth.js](file:///workspace/server/src/middleware/adminAuth.js#L15-L18) 中的 `SELECT id, token_version FROM users/admins WHERE id = ?`。Socket.IO 的 `match:join` 事件则通过 `verify(token)` 直接信任 JWT 内的 `tokenVersion`，不查库（见 [matchSocket.js#L107-L109](file:///workspace/server/src/sockets/matchSocket.js#L107-L109)）。
- **AI 配置链路**：`aiRouter.callRole` 每次调用都会触发 [aiConfigService.getRoleByKey](file:///workspace/server/src/services/aiConfigService.js#L169-L182)，进而执行 [getRoleBindings](file:///workspace/server/src/services/aiConfigService.js#L190-L219) —— 一条 3 表 JOIN（`ai_role_models` ⋈ `ai_models` ⋈ `ai_providers`）+ 对 `api_key` 做 AES-256-GCM `decrypt`。海龟汤每轮提问都会调用一次。
- **写路径**：AI 配置写入分散在 [aiRoutes.js](file:///workspace/server/src/routes/aiRoutes.js)（直接 `db.run`），未经过 `aiConfigService`。登出在 [userRoutes.js#L43](file:///workspace/server/src/routes/userRoutes.js#L43) 和 [adminRoutes.js#L78](file:///workspace/server/src/routes/adminRoutes.js#L78) 通过 `token_version = token_version + 1` 吊销。
- **Socket.IO**：单实例内存适配器（[index.js#L21-L23](file:///workspace/server/src/index.js#L21-L23)），无横向扩展能力。
- **依赖**：[package.json](file:///workspace/server/package.json) 当前无任何 Redis 相关包。
- **配置**：[config.js](file:///workspace/server/src/config.js) 无 Redis 配置项；[.env.example](file:///workspace/server/.env.example) 无 Redis 变量。

## Proposed Changes

### 1. 新增 `server/src/redis.js` — Redis 客户端 + 缓存封装

单文件模块，导出：
- `getClient()` — 返回底层 ioredis 实例（供 Socket.IO adapter 复用）
- `isAvailable()` — boolean，Redis 是否就绪
- `get(key)` — 反序列化 JSON；不可用 / miss 时返回 `null`
- `set(key, value, ttlSec)` — JSON 序列化 + `SETEX`；不可用时静默跳过
- `del(key)` — 不可用时静默返回 0
- `delByPrefix(prefix)` — 用 `SCAN`（非 `KEYS`）批量删除；不可用时静默跳过
- `getOrSet(key, ttlSec, loader)` — read-through 封装：cache miss 时执行 `loader()` 取值并回填
- `invalidateAiConfig()` — 等价于 `delByPrefix(prefix + 'ai:*')`
- `shutdown()` — 优雅关闭（用于测试 / 进程退出）

实现要点：
- 使用 `ioredis`（支持 Promise / 集群 / sentinel，社区主流）
- 连接配置：`enableOfflineQueue: false` + `maxRetriesPerRequest: 1` —— Redis 离线时命令立即失败而非排队，确保降级路径快速返回
- 状态机：监听 `ready` / `error` / `close` / `reconnecting` 事件维护 `isAvailable` 标志
- 支持两种配置入口：`REDIS_URL`（优先）或 `REDIS_HOST` + `REDIS_PORT` + `REDIS_PASSWORD` + `REDIS_DB` + `REDIS_KEY_PREFIX`
- 所有 `get/set/del` 入口先判断 `isAvailable()`，false 时 `get` 返回 `null`、`set/del` 返回 falsy，让上层自然走 DB 回退

### 2. 编辑 `server/src/config.js` — 新增 `redis` 配置块

在 `module.exports` 中追加：
```js
redis: {
  url: process.env.REDIS_URL || '',
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || '',
  db: parseInt(process.env.REDIS_DB || '0', 10),
  keyPrefix: process.env.REDIS_KEY_PREFIX || 'ts:',
},
```
不强制启动校验（与现有 `API_KEY_ENCRYPTION_KEY` 同策略：缺失仅 `console.warn`，不 `process.exit`）。

### 3. 编辑 `server/package.json` — 新增依赖

在 `dependencies` 中添加：
- `"ioredis": "^5.4.1"` — Redis 客户端
- `"@socket.io/redis-adapter": "^8.3.0"` — Socket.IO 横向扩展适配器

### 4. 编辑 `server/src/index.js` — 启用 Socket.IO Redis 适配器 + 健康检查

- 在 `boot()` 内 `db.initSchema()` 之后调用 `redis` 模块的初始化（设置事件监听即可，ioredis 自带惰性连接）
- 创建两个 ioredis 客户端（`pubClient` + `subClient`，复用同一连接配置），调用 `io.adapter(createAdapter(pubClient, subClient))`
  - 若 Redis 不可用，跳过 adapter（保持内存适配器，单实例仍可工作）
- `/api/health` 响应中追加 `redis: redis.isAvailable()`

### 5. 编辑 `server/src/middleware/userAuth.js` — token_version 读穿透缓存

将 `db.getOne('SELECT id, token_version FROM users WHERE id = ?', ...)` 改为 `getOrSet`：
```js
const cached = await redis.getOrSet(
  `${prefix}auth:u:${decoded.userId}`,
  60, // TTL 60s 作为兜底
  async () => {
    const u = await db.getOne('SELECT id, token_version FROM users WHERE id = ?', [decoded.userId]);
    if (!u) return null; // null 也会被缓存？→ 不会，见下
    return { tokenVersion: u.token_version };
  }
);
```
注意点：
- 用户不存在时**不缓存 null**（避免新建用户后短时间内仍 401）。`getOrSet` 实现里 loader 返回 `null`/`undefined` 时跳过 `set`、直接返回
- 命中缓存后跳过 DB 查询；未命中或 Redis 不可用时回退到原 DB 查询
- `optionalUserAuth` 同步修改同一逻辑

### 6. 编辑 `server/src/middleware/adminAuth.js` — 同样的读穿透缓存

key 为 `${prefix}auth:a:${decoded.id}`，TTL 60s。loader 查 `admins` 表。

### 7. 编辑 `server/src/routes/userRoutes.js` — 登出时删缓存

`POST /api/users/logout` 在 `UPDATE users SET token_version = token_version + 1` 之后追加：
```js
await redis.del(`${prefix}auth:u:${req.user.userId}`);
```
确保旧 token 立即失效（不必等 60s TTL）。Redis 不可用时 `del` 静默返回。

### 8. 编辑 `server/src/routes/adminRoutes.js` — 登出时删缓存

`POST /api/admin/logout` 在 `UPDATE admins SET token_version = token_version + 1` 之后追加：
```js
await redis.del(`${prefix}auth:a:${req.admin.id}`);
```

### 9. 编辑 `server/src/services/aiConfigService.js` — 读穿透 + 失效辅助函数

为以下读函数加 `redis.getOrSet` 包装（key 列在注释中）：
- `listProviders(includeDisabled)` → `ai:providers:${includeDisabled}` （TTL 120s）
- `getProvider(id)` → `ai:provider:${id}` （TTL 120s）
- `listModels(providerId)` → `ai:models:${providerId || 'all'}` （TTL 120s）
- `getModel(id)` → `ai:model:${id}` （TTL 120s）
- `listRoles()` → `ai:roles` （TTL 120s）
- `getRoleById(id)` → `ai:role_by_id:${id}` （TTL 120s）
- `getRoleByKey(roleKey)` → `ai:role_key:${roleKey}` （TTL 120s；内层仍调 `getRoleBindings`，但 `getRoleBindings` 不单独缓存，由 `getRoleByKey` 整体缓存含 models 的对象）
- `getRoleBindingsAdmin(roleId)` → `ai:bindings_admin:${roleId}` （TTL 120s）
- `hasEnabledProvider()` → `ai:has_enabled` （TTL 60s）

新增导出：
```js
async function invalidateAiConfigCache() {
  await redis.delByPrefix(`${prefix}ai:*`);
}
```
（用前缀批量删，避免维护 N 个 key 的精确失效映射；AI 配置写操作稀少，全量失效成本低）

### 10. 编辑 `server/src/routes/aiRoutes.js` — 写操作后失效 AI 缓存

在以下端点的成功写操作之后调用 `await aiConfig.invalidateAiConfigCache()`：
- `POST / PUT / DELETE /admin/ai/providers`（3 处）
- `POST / PUT / DELETE /admin/ai/models`（3 处）
- `POST / PUT / DELETE /admin/ai/roles`（3 处）
- `PUT /admin/ai/roles/:id/models`（1 处，绑定整体替换）
- `PATCH /admin/ai/roles/:id/strategy`（1 处）

共 11 处。统一在 `db.run` / `db.withTransaction` 成功之后、`res.json` 之前调用。

### 11. 编辑 `server/.env.example` — 新增 Redis 配置示例

```env
# Redis 缓存（可选；未配置或不可用时自动降级直查 DB）
# 推荐用 URL：REDIS_URL=redis://[:password@]host:port/db
REDIS_URL=
# 或使用以下分项配置（与 REDIS_URL 二选一）
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_KEY_PREFIX=ts:
```

## Assumptions & Decisions

1. **降级策略**：Redis 不可用时，所有 `getOrSet` 的 loader 仍会执行（即直查 DB），服务行为与改造前完全一致。`set/del` 静默失败。启动不阻塞、不退出。
2. **TTL 兜底 + 主动失效**：auth 60s / AI 120s TTL 仅作内存兜底；正确性依赖登出和 admin 写操作时的主动 `del` / `delByPrefix`。
3. **多实例一致性**：所有实例共享同一 Redis，登出 `del` 对所有实例立即生效；AI 配置失效同理。Socket.IO adapter 保证广播 / 房间跨实例同步。
4. **缓存 null 值策略**：`getOrSet` 中 loader 返回 `null`/`undefined` 时**不写入缓存**，避免「用户不存在」短时缓存导致新建用户被误判。
5. **失效粒度**：AI 配置统一用 `delByPrefix('ai:*')` 全量失效，不维护细粒度 key 映射。理由：AI 配置写入稀少（仅管理员）、key 数量少（< 100）、全量失效实现简单且无一致性陷阱。
6. **不缓存的范围**（按用户选择「仅核心高频项」）：puzzles 详情、admin/dashboard、reveal 数据均不缓存，留给后续迭代。
7. **包版本**：ioredis ^5.4.1（Node ≥18 兼容）、@socket.io/redis-adapter ^8.3.0（与 socket.io ^4.8 兼容）。
8. **Redis 客户端复用**：缓存模块与 Socket.IO adapter 共用底层连接配置，但 adapter 用独立的 `pubClient` + `subClient`（避免 pub/sub 阻塞业务命令）。
9. **不引入连接池**：ioredis 单连接自带 pipelining，足以支撑当前 QPS；后续若需要再升级 cluster。
10. **保持原有 API 契约**：所有 HTTP / Socket 接口签名与响应格式不变。

## Verification Steps

1. **降级模式**：不配置 `REDIS_URL` 启动服务 → 控制台输出警告但服务正常启动；调用 `/api/user/profile`、`/api/admin/ai/roles` 均返回正确数据；`/api/health` 返回 `redis: false`。
2. **缓存命中**：配置 `REDIS_URL=redis://127.0.0.1:6379` 启动 → `/api/health` 返回 `redis: true`；连续两次调用 `/api/admin/ai/roles`，第二次通过 `redis-cli MONITOR` 应只看到一次 GET。
3. **登出即时失效**：登录 user A → 调用 `/api/user/profile` 成功 → 调用 `/api/users/logout` → 用同一 token 再调 `/api/user/profile` 应立即返回 401（不依赖 TTL）；`redis-cli GET ts:auth:u:{userId}` 应返回 nil。
4. **AI 配置失效**：管理员修改某 provider 的 enabled 状态 → 立即在新对局中触发 AI 判定 → 应使用最新配置；`redis-cli KEYS ts:ai:*` 应为空（已被 `delByPrefix` 清空）。
5. **Redis 中断容错**：服务运行中 `docker stop redis` → 后续请求不应 500，应回退直查 DB；`docker start redis` → `isAvailable` 自动恢复 true，缓存重新生效。
6. **Socket.IO 跨实例广播**（可选验证）：起两个 Node 实例（PORT=3000 / 3001）共享 Redis + nginx 负载均衡 → 同一 `game:{id}` 房间内分别连接到两实例的两个客户端，应能互相收到 `game:turn` 广播。
7. **现有功能回归**：跑一遍完整对局流程（匹配 → 提问 → 判定 → 揭晓）+ 管理后台题库 / AI 配置 CRUD，确认无回归。
