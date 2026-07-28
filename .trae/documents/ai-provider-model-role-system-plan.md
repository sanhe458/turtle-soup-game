# AI 机制重构计划：Provider / Model / Role 三层体系

## 概述

将当前"单一供应商(智谱)+单一模型(glm-4-flash)+硬编码"的 AI 系统，重构为「供应商 → 模型 → 角色」三层可配置体系。供应商支持 OpenAI / Anthropic / Gemini 三种协议格式 + 自定义端点；模型挂载在供应商下，支持自定义模型 ID、上下文窗口、最大输出长度、支持的模态；角色对应每个 AI 使用场景（如游戏判定、补位 AI 提问），每个角色可绑定多个模型进行轮询，并支持 4 种独立的轮询策略（顺序轮询 / 主备故障转移 / 加权随机 / 负载均衡）。

项目处于开发阶段，用户已明确表示"可放开手脚大胆改"，因此本计划直接移除旧智谱硬编码配置，不做向后兼容。

---

## 当前状态分析

### 现有 AI 架构（需替换）

| 文件 | 现状 |
|------|------|
| [llmService.js](file:///workspace/server/src/services/llmService.js) | `callZhipu()` 硬编码智谱端点；`judgeQuestion()` 与 `generateBotQuestion()` 共用同一调用，无角色概念 |
| [config.js](file:///workspace/server/src/config.js#L9-L14) | `zhipu: { apiKey, model, baseUrl, timeoutMs }` 硬编码块 |
| [.env.example](file:///workspace/server/.env.example#L7-L9) | `ZHIPU_API_KEY` / `ZHIPU_MODEL` 环境变量 |
| [index.js](file:///workspace/server/src/index.js#L34-L36) | 启动时检查 `config.zhipu.apiKey` 并打印警告 |
| [db.js](file:///workspace/server/src/db.js) | 完全没有 AI 相关表 |
| [adminRoutes.js](file:///workspace/server/src/routes/adminRoutes.js) | 完全没有 AI 配置 API |
| [admin-puzzles.html](file:///workspace/pages/admin-puzzles.html#L206-L209) | 侧边栏"AI 配置"菜单项 `href="#"` 死链接 |
| [admin-dashboard.html](file:///workspace/pages/admin-dashboard.html#L211-L214) | 同上死链接 |
| [api.js](file:///workspace/js/api.js) | 没有 AI 配置相关方法 |

### 现有 AI 使用场景（天然角色种子）

1. **`judge`** — 游戏内判定玩家提问（是/不是/无关 + 是否接近真相），调用方 [gameService.js#L228](file:///workspace/server/src/services/gameService.js#L228)
2. **`bot_question`** — 补位 AI 机器人生成提问，调用方 [botService.js#L31-L33](file:///workspace/server/src/services/botService.js#L31-L33) → [llmService.generateBotQuestion](file:///workspace/server/src/services/llmService.js#L85)

### 复用的现有模式

- 后端路由模式：见 [adminRoutes.js](file:///workspace/server/src/routes/adminRoutes.js)（`router.get/post/put/patch/delete` + `adminAuth` 中间件 + `db.prepare`）
- 数据库模式：`better-sqlite3` 同步 API，`initSchema()` 中 `CREATE TABLE IF NOT EXISTS`
- 前端页面模式：[admin-puzzles.html](file:///workspace/pages/admin-puzzles.html)（左侧深色边栏 + 玻璃拟态卡片 + 右侧滑出编辑面板 + Tailwind v4 browser CDN + Lucide 图标）
- API 封装：[api.js](file:///workspace/js/api.js) 的 `Api.request(method, path, body, { admin: true })` 模式
- 工具：[helpers.js](file:///workspace/js/helpers.js) 的 `Helpers.escape / toast / refreshIcons / el`

---

## 设计决策

### 1. 数据库表设计（4 张新表 + ai_roles 内嵌策略字段）

```
ai_providers    供应商   (id, name, format, base_url, api_key, enabled, sort_order, timestamps)
ai_models       模型     (id, provider_id FK, name, model_id, context_window, max_output, modalities JSON, enabled, sort_order, timestamps)
ai_roles        角色     (id, role_key UNIQUE, name, description, is_builtin, polling_strategy, enabled, timestamps)
ai_role_models  绑定关系 (id, role_id FK, model_id FK, priority, weight, enabled, sort_order, created_at, UNIQUE(role_id, model_id))
```

- `format`: `'openai' | 'anthropic' | 'gemini'`（决定请求格式适配）
- `modalities`: JSON 数组字符串，如 `'["text","image"]'`
- `polling_strategy`: `'round_robin' | 'failover' | 'weighted_random' | 'load_balance'`（直接放 ai_roles 表，每个角色独立）
- `priority`（仅 failover 用，小值优先）、`weight`（仅 weighted_random 用）放在绑定关系表
- API Key 明文存 SQLite（本地单机开发项目，无加密必要；API 响应中掩码返回 `sk-****abcd`）

### 2. 四种轮询策略实现（内存状态）

| 策略 | 选择算法 | 内存状态 |
|------|----------|----------|
| `round_robin` 顺序轮询 | 按 sort_order 循环取下一个 | `Map<roleId, nextIndex>` |
| `failover` 主备故障转移 | 按 priority 升序取第一个；调用失败则取下一个 | 无状态（失败时在调用循环内重试） |
| `weighted_random` 加权随机 | 按 weight 加权随机选一个 | 无状态 |
| `load_balance` 负载均衡 | 取在途请求数最少的模型；并列时按 sort_order | `Map<modelBindingId, inFlightCount>` |

所有策略在「无可用模型 / 所有模型均失败」时，由 llmService 走原有降级逻辑（判定返回"无关"，bot 提问返回兜底问题池）。

### 3. 三种协议格式适配

- **OpenAI**：`POST {base_url}/chat/completions`，header `Authorization: Bearer {api_key}`，body `{ model, messages, temperature, response_format?, max_tokens? }`，解析 `data.choices[0].message.content`
- **Anthropic**：`POST {base_url}/v1/messages`，header `x-api-key: {api_key}` + `anthropic-version: 2023-06-01`，body `{ model, messages, max_tokens, temperature }`，解析 `data.content[0].text`
- **Gemini**：`POST {base_url}/v1beta/models/{model}:generateContent?key={api_key}`，body `{ contents: [{ parts: [{ text }] }], generationConfig }`，解析 `data.candidates[0].content.parts[0].text`

### 4. 角色管理：代码种子 + 后台可增删

- 启动时种子化两个内置角色：`judge`（is_builtin=1）、`bot_question`（is_builtin=1）
- 内置角色不可删除（API 拦截），但可改模型绑定与策略
- 管理员可新增自定义角色（指定 role_key 供代码引用），可删除自定义角色

---

## 实施步骤

### 步骤 1：数据库 schema 扩展

**文件**：[db.js](file:///workspace/server/src/db.js)

在 `initSchema()` 的 `CREATE TABLE IF NOT EXISTS admins` 之后，追加 4 张表：

```sql
CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL,                -- openai | anthropic | gemini
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,              -- 如 gpt-4o, claude-3-5-sonnet
  context_window INTEGER DEFAULT 128000,
  max_output INTEGER DEFAULT 4096,
  modalities TEXT DEFAULT '["text"]',  -- JSON 数组
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_roles (
  id TEXT PRIMARY KEY,
  role_key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_builtin INTEGER DEFAULT 0,
  polling_strategy TEXT DEFAULT 'round_robin', -- round_robin | failover | weighted_random | load_balance
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_role_models (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES ai_roles(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  priority INTEGER DEFAULT 0,
  weight INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(role_id, model_id)
);
```

在 `initSchema()` 调用后，追加种子逻辑：用 `INSERT OR IGNORE` 插入 `judge` 与 `bot_question` 两个内置角色。

### 步骤 2：AI 配置读取服务

**新建文件**：`/workspace/server/src/services/aiConfigService.js`

提供从数据库读取配置的纯查询函数（不涉及调用）：

- `listProviders(includeDisabled)` → 返回供应商列表（api_key 掩码）
- `getProvider(id)` → 单个供应商（含明文 key，仅内部用）
- `listModels(providerId?)` → 模型列表（带供应商名 join）
- `getModel(id)`
- `listRoles()` → 角色列表
- `getRoleByKey(roleKey)` → 单个角色（含绑定模型 + 供应商信息，供 llmService 调用时用）
- `getRoleBindings(roleId)` → 角色绑定的模型列表（按策略排序）
- 掩码函数 `maskKey(key)` → `sk-****后4位`

`getRoleByKey` 返回结构（供路由层使用）：
```js
{
  id, role_key, name, polling_strategy, enabled,
  models: [
    { bindingId, model_id, name, context_window, max_output, modalities,
      provider: { id, format, base_url, api_key }, priority, weight, sort_order }
  ]
}
```

### 步骤 3：AI 路由与调用服务（核心）

**新建文件**：`/workspace/server/src/services/aiRouter.js`

负责"根据角色选模型 + 按协议调用"：

- 内存状态：
  - `roundRobinIndex: Map<roleKey, number>`
  - `inFlightCount: Map<bindingId, number>`
- `selectModel(roleConfig)` — 按角色 `polling_strategy` 返回一个绑定模型
- `callProvider(provider, model, messages, opts)` — 按 `provider.format` 分发到三个适配器
- `callOpenAI(provider, model, messages, opts)`
- `callAnthropic(provider, model, messages, opts)`
- `callGemini(provider, model, messages, opts)`
- `callRole(roleKey, messages, opts)` — 顶层入口：读角色配置 → 选模型 → 调用；`failover` 策略下失败自动尝试下一个模型
- `releaseInFlight(bindingId)` — load_balance 计数递减

### 步骤 4：重写 llmService

**文件**：[llmService.js](file:///workspace/server/src/services/llmService.js)

- 移除 `callZhipu()` 与对 `config.zhipu` 的引用
- `judgeQuestion()` 内部改为 `await aiRouter.callRole('judge', [{role:'user', content:prompt}], { temperature:0.3, jsonMode:true })`
- `generateBotQuestion()` 内部改为 `await aiRouter.callRole('bot_question', ...)`
- 保留 `extractJson()`、`JUDGMENT_LABELS`、降级/兜底逻辑不变
- 导出接口签名不变（`gameService` / `botService` 调用方无需改动）

### 步骤 5：AI 管理 REST API

**新建文件**：`/workspace/server/src/routes/aiRoutes.js`

统一挂在 `/api/admin/ai` 下，全部走 `adminAuth` 中间件：

```
供应商:
  GET    /api/admin/ai/providers
  POST   /api/admin/ai/providers
  PUT    /api/admin/ai/providers/:id
  DELETE /api/admin/ai/providers/:id

模型:
  GET    /api/admin/ai/models?providerId=
  POST   /api/admin/ai/models
  PUT    /api/admin/ai/models/:id
  DELETE /api/admin/ai/models/:id

角色:
  GET    /api/admin/ai/roles
  POST   /api/admin/ai/roles
  PUT    /api/admin/ai/roles/:id
  DELETE /api/admin/ai/roles/:id          (拦截 is_builtin=1)

角色-模型绑定:
  GET    /api/admin/ai/roles/:id/models
  PUT    /api/admin/ai/roles/:id/models   (整体替换绑定列表)
  PATCH  /api/admin/ai/roles/:id/strategy (单独改轮询策略)

测试:
  POST   /api/admin/ai/test               (body: { modelId, prompt } → 返回模型响应)
```

校验：`format` 必须 ∈ `['openai','anthropic','gemini']`；`polling_strategy` 必须 ∈ 4 种之一；删除供应商时级联删除其下模型（FK ON DELETE CASCADE 已处理）。

### 步骤 6：注册路由 + 清理旧配置

**文件**：[index.js](file:///workspace/server/src/index.js)
- 新增 `app.use('/api', require('./routes/aiRoutes'));`
- 移除第 34-36 行的 `config.zhipu.apiKey` 警告，改为检查数据库中是否有启用的供应商，无则打印 `WARNING: 未配置任何 AI 供应商，AI 角色将走降级逻辑`

**文件**：[config.js](file:///workspace/server/src/config.js)
- 删除第 9-14 行的 `zhipu` 配置块

**文件**：[.env.example](file:///workspace/server/.env.example)
- 删除第 7-9 行的 `ZHIPU_API_KEY` / `ZHIPU_MODEL`，并加注释说明 AI 配置请在管理后台「AI 配置」页面维护

### 步骤 7：前端 API 封装扩展

**文件**：[api.js](file:///workspace/js/api.js)

在 `adminUpdatePuzzleStatus` 之后追加 AI 配置相关方法（均 `{ admin: true }`）：

```js
// 供应商
adminListProviders()
adminCreateProvider(data)
adminUpdateProvider(id, data)
adminDeleteProvider(id)
// 模型
adminListModels(providerId?)
adminCreateModel(data)
adminUpdateModel(id, data)
adminDeleteModel(id)
// 角色
adminListRoles()
adminCreateRole(data)
adminUpdateRole(id, data)
adminDeleteRole(id)
// 角色绑定与策略
adminGetRoleModels(id)
adminUpdateRoleModels(id, bindings)   // bindings: [{modelId, priority, weight, enabled, sortOrder}]
adminUpdateRoleStrategy(id, strategy)
// 测试
adminTestAI(modelId, prompt)
```

### 步骤 8：AI 配置页面

**新建文件**：`/workspace/pages/admin-ai.html`

完全复用 [admin-puzzles.html](file:///workspace/pages/admin-puzzles.html) 的设计语言（左侧边栏 + 顶栏 + 玻璃拟态卡片 + 右侧滑出编辑面板 + Tailwind v4 + Lucide）。页面顶部用三个 Tab 切换：**供应商 / 模型 / 角色**。

#### 8.1 供应商 Tab
- 顶部统计卡：供应商总数、启用数、模型总数、角色数
- 卡片网格列表：每个供应商一张玻璃拟态卡片，显示 name、format 徽章、base_url、模型数量、启用开关、编辑/删除按钮
- 编辑面板字段：名称、协议格式（3 个按钮选择：OpenAI / Anthropic / Gemini）、Base URL（按格式预填默认值）、API Key（密码框，编辑时占位显示掩码）

#### 8.2 模型 Tab
- 顶部筛选：供应商下拉
- 卡片网格列表：每张卡片显示模型 name、model_id（mono 字体）、所属供应商、context_window、max_output、模态徽章（text/image/audio）、启用开关、编辑/删除
- 编辑面板字段：所属供应商（下拉，必选）、显示名称、模型 ID、上下文窗口大小（数字，单位 tokens）、最大输出长度（数字）、支持的模态（多选 chip：text / image / audio / tool）

#### 8.3 角色 Tab
- 卡片网格列表：每张卡片显示角色 name、role_key（mono）、描述、内置标记、当前策略徽章、绑定模型数、编辑按钮（内置角色不可删除，隐藏删除按钮）
- 编辑面板字段：
  - 名称、role_key（内置角色禁用编辑）、描述
  - 轮询策略（4 个按钮选择：顺序轮询 / 主备故障转移 / 加权随机 / 负载均衡）
  - 绑定模型区：可勾选多个模型；每个勾选的模型展开显示 priority（仅 failover 时启用）、weight（仅 weighted_random 时启用）输入框；可拖拽或用 sortOrder 上下箭头调整顺序（round_robin / load_balance 时生效）
  - 「测试此角色」按钮：用当前配置发一条测试消息，显示响应或错误

#### 8.4 通用交互
- 所有列表加载、保存、删除均走 `Helpers.toast` 反馈
- 编辑面板用 `is-open-panel` class 控制（同 admin-puzzles.html 模式）
- 移动端边栏抽屉、图标刷新 `Helpers.refreshIcons()` 均沿用现有实现

### 步骤 9：激活侧边栏 AI 配置入口

**文件**：
- [admin-puzzles.html#L206-L209](file:///workspace/pages/admin-puzzles.html#L206)：将「AI 配置」`href="#"` 改为 `href="admin-ai.html"`
- [admin-dashboard.html#L211-L214](file:///workspace/pages/admin-dashboard.html#L211)：同上
- 检查其他 admin-*.html 页面是否有相同的死链接，一并修复（搜索 `AI 配置` 或 `href="#"`）

新建的 `admin-ai.html` 中，AI 配置菜单项需加 `active` class 高亮，其他菜单项保持 `href` 指向各自页面。

---

## 验证步骤

### 后端验证
1. `node server/src/index.js` 启动服务，确认无报错、schema 建表成功、内置角色种子写入
2. 用 curl/Postman 测试 AI 配置 API 全流程：
   - 创建一个 OpenAI 格式供应商 → 创建一个模型挂在它下面 → 创建一个自定义角色 → 绑定模型 → 设置策略 → 调用 `/api/admin/ai/test` 验证模型可达
   - 测试删除内置角色应返回 400
   - 测试删除供应商后其下模型应级联消失
3. 配置 `judge` 角色绑定一个真实模型后，启动一局游戏提问，验证判定走的是新配置的模型（看日志）
4. 给 `bot_question` 绑定多个模型 + round_robin 策略，多次触发补位 AI，验证轮流使用不同模型
5. 配置 failover 策略 + 一个故意失效的模型 + 一个有效模型，验证失败自动切换
6. 未配置任何供应商时，游戏判定降级为"无关"、bot 提问降级为兜底问题池

### 前端验证
1. 浏览器打开 `admin-ai.html`，三个 Tab 切换正常
2. 完成供应商/模型/角色的增删改查全流程
3. 角色编辑面板的轮询策略切换时，priority/weight 输入框的启用/禁用联动正确
4. 移动端边栏抽屉、编辑面板滑出、toast 反馈、图标渲染均正常
5. 从 admin-dashboard / admin-puzzles 的侧边栏可跳转到 admin-ai 并高亮

---

## 假设与约定

- **API Key 存储**：明文存 SQLite（本地单机开发项目），API 响应中掩码返回，前端编辑时占位显示掩码、留空表示不修改
- **协议格式默认 Base URL**：OpenAI `https://api.openai.com/v1`、Anthropic `https://api.anthropic.com`、Gemini `https://generativelanguage.googleapis.com`，用户可覆盖
- **超时**：沿用原 `8000ms`，硬编码在 aiRouter 中（无需每个模型单独配）
- **temperature / jsonMode**：由调用方（llmService）在 opts 中传入，judge 与 bot_question 均用 `temperature:0.3` + `jsonMode:true`（OpenAI 格式传 `response_format`，Anthropic/Gemini 靠 prompt 约束 JSON 输出）
- **现有 prompts.js 不改动**：角色与 prompt 解耦，prompt 仍由 llmService 内部组装
- **调用方不改**：`gameService.judgeQuestion()` 与 `botService.generateQuestion()` 的接口签名保持不变，角色标识封装在 llmService 内部
