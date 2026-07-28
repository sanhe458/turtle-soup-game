# 安全漏洞修复计划 — 剩余 Bug（/plan /bug）

## Summary

经全项目端到端复查，[既有安全 Spec](file:///workspace/.trae/specs/security-audit-fixes/spec.md) 中绝大多数条目（helmet/CSP、限流、tokenVersion 吊销、SSRF 防护、API Key 掩码、字段校验、时序侧信道、bcrypt 异步、全局错误处理等）**均已落地**。本次复查仅发现 **3 项遗留真实 Bug**，本计划聚焦修复它们。原审计中担心的「管理后台 XSS」经逐行核实为**误报**（所有动态字段已用 `Helpers.escape()`，API Key 仅显示「已配置/未配置」固定文案），不在本计划范围。

## Current State Analysis

### Bug 1（CRITICAL）— API Key 写入未加密
- **现状**：[aiRoutes.js#L78-L81](file:///workspace/server/src/routes/aiRoutes.js#L78) 的 INSERT 与 [aiRoutes.js#L101-L112](file:///workspace/server/src/routes/aiRoutes.js#L101) 的 UPDATE 直接把 `apiKey` 原文写入 `ai_providers.api_key`。
- **读取侧已正确**：[aiConfigService.js#L47](file:///workspace/server/src/services/aiConfigService.js#L47)（列表掩码 `maskKey(decrypt(...))`）、[#L65](file:///workspace/server/src/services/aiConfigService.js#L65)、[#L138](file:///workspace/server/src/services/aiConfigService.js#L138)、[#L239](file:///workspace/server/src/services/aiConfigService.js#L239) 均调用 `decrypt()`，且 [crypto.js#L29](file:///workspace/server/src/utils/crypto.js#L29) 的向后兼容逻辑会让明文原样透传——所以功能"看起来正常"，但 DB 里存的是明文。
- **根因**：`encrypt()` 在 [crypto.js#L14](file:///workspace/server/src/utils/crypto.js#L14) 已实现，但 `aiRoutes.js` 从未 import 也从未调用它。`aiConfigService.js` 顶部注释（[#L1-L3](file:///workspace/server/src/services/aiConfigService.js#L1)）也明确指出"建议运行迁移脚本 encrypt 历史数据，或通过管理后台重新保存每个供应商以触发加密"——然而写入路径根本没接 encrypt，重新保存也无济于事。

### Bug 2（FUNCTIONAL/HIGH）— 角色不匹配导致 /admin/ai/test 永远 403
- **现状**：[aiRoutes.js#L326](file:///workspace/server/src/routes/aiRoutes.js#L326) 调用 `requireRole('superadmin')`，而 [seed.js#L110](file:///workspace/server/seed.js#L110) 创建管理员时 `role = '超级管理员'`。
- **链路**：[adminRoutes.js#L70](file:///workspace/server/src/routes/adminRoutes.js#L70) `signAdmin(..., admin.role, ...)` 把 DB 中的 `'超级管理员'` 写入 JWT → [adminAuth.js#L35](file:///workspace/server/src/middleware/adminAuth.js#L35) `req.admin.role = decoded.role` → [adminAuth.js#L45](file:///workspace/server/src/middleware/adminAuth.js#L45) `req.admin.role !== role` 严格比较 `'超级管理员' !== 'superadmin'` → 永远 403。
- **影响**：默认种子管理员无法使用 AI 模型测试功能（admin-ai.html 的「测试」按钮）。
- **`requireRole` 全局仅此一处使用**（已 grep 确认）。

### Bug 3（CONFIG/LOW）— `.env.example` 缺 `API_KEY_ENCRYPTION_KEY`
- **现状**：[config.js#L18-L22](file:///workspace/server/src/config.js#L18) 读取并校验 `API_KEY_ENCRYPTION_KEY`，[crypto.js#L7](file:///workspace/server/src/utils/crypto.js#L7) `getKey()` 在缺失时抛错，但 [.env.example](file:///workspace/server/.env.example) 完全没有该变量。
- **影响**：修复 Bug 1 后，保存供应商时若该变量未配置，`encrypt()` 会抛错导致 500。需在模板中明示。

### 误报说明（XSS）
admin-ai.html / admin-puzzles.html / admin-dashboard.html 的所有 innerHTML 动态拼接均已用 `Helpers.escape()` 包裹（如 [admin-ai.html#L410](file:///workspace/pages/admin-ai.html#L410)、[admin-puzzles.html#L665](file:///workspace/pages/admin-puzzles.html#L665)）；API Key 展示为 `p.apiKey ? '已配置' : '未配置'`（[admin-ai.html#L421](file:///workspace/pages/admin-ai.html#L421)），不回显密钥。无需处理。

## Assumptions & Decisions

1. **角色修复方式**：采用「标准化为 `superadmin` 机器键」——改 `seed.js` 的 role 值为 `'superadmin'`，并在前端把键映射回中文标签展示。理由：`requireRole` 应基于稳定的机器键而非本地化显示串；`requireRole('superadmin')` 与 Spec「仅 superadmin 角色可访问」语义一致。
2. **历史明文 Key**：用户确认项目仍在开发阶段、无真实数据，**不写迁移脚本**。仅修复写入路径；现有明文 Key 靠 `decrypt()` 向后兼容逻辑继续工作，下次重新保存即自动加密落库。
3. **PUT 时无新 Key 的处理**：`existing.apiKey` 来自 `getProvider()` 已是解密明文，直接 `encrypt(newApiKey)` 重新加密落库（每次新 IV，安全且幂等）。不采用「无新 Key 则不动该列」的条件 SQL，以保持改动最小、SQL 结构不变。
4. **前端角色展示**：新增 `Helpers.adminRoleLabel(role)` 工具函数集中映射，避免在 3 个页面重复定义。

## Proposed Changes

### 改动 1 — 修复 API Key 写入加密（Bug 1）
**文件**：[server/src/routes/aiRoutes.js](file:///workspace/server/src/routes/aiRoutes.js)

- **What**：引入 `encrypt`，在 INSERT/UPDATE 两条写入路径对 `api_key` 加密。
- **Why**：闭合「读取已解密、写入未加密」的缺口，使 DB 中 `api_key` 字段始终为 AES-256-GCM 密文。
- **How**：
  1. 顶部新增导入：`const { encrypt } = require('../utils/crypto');`（与现有 `require('../services/aiConfigService')` 同区）。
  2. INSERT（[L78-L81](file:///workspace/server/src/routes/aiRoutes.js#L78)）：第 5 个参数 `apiKey || ''` → `encrypt(apiKey || '')`。
  3. PUT（[L95](file:///workspace/server/src/routes/aiRoutes.js#L95)）：`newApiKey` 计算逻辑不变（已是明文：新 Key 或解密后的旧 Key）；UPDATE 参数列表（[L108](file:///workspace/server/src/routes/aiRoutes.js#L108)）中 `newApiKey` → `encrypt(newApiKey)`。
- **边界**：若 `API_KEY_ENCRYPTION_KEY` 未配置，`encrypt()` 抛错会冒泡到全局错误中间件返回 500「服务器内部错误」；启动期 [config.js#L20](file:///workspace/server/src/config.js#L20) 已有 warn 提示。可接受（fail-loud），不做额外 try/catch 以免掩盖配置错误。

### 改动 2 — 标准化管理员角色键为 `superadmin`（Bug 2）

#### 2a. 后端种子数据
**文件**：[server/seed.js](file:///workspace/seed.js#L110)
- **What**：第 110 行 `role` 值 `'超级管理员'` → `'superadmin'`。
- **Why**：与 `requireRole('superadmin')` 对齐，使默认管理员能通过 AI 测试端点鉴权。
- **How**：单字符替换。其余字段（account/name/email）不变。

#### 2b. 前端角色标签映射
**文件**：[js/helpers.js](file:///workspace/js/helpers.js)
- **What**：新增 `adminRoleLabel(role)` 方法，返回 `{ superadmin: '超级管理员' }[role] || role || '—'`。
- **Why**：role 改为机器键后，侧边栏 `#admin-role` 直接展示 `superadmin` 不友好；集中映射避免 3 处重复。
- **How**：在 `Helpers` 对象内（`escape` 之后）追加该方法并随 `window.Helpers` 一并导出。

**文件**：3 个管理后台页面，把 `roleEl.textContent = info.role || '—';` 改为 `roleEl.textContent = Helpers.adminRoleLabel(info.role);`
- [pages/admin-ai.html#L291](file:///workspace/pages/admin-ai.html#L291)
- [pages/admin-dashboard.html#L623](file:///workspace/pages/admin-dashboard.html#L623)
- [pages/admin-puzzles.html#L574](file:///workspace/pages/admin-puzzles.html#L574)

> 注：`requireRole('superadmin')`（[aiRoutes.js#L326](file:///workspace/server/src/routes/aiRoutes.js#L326)）**保持不变**——它已是正确的机器键。

### 改动 3 — 补全 `.env.example` 的 `API_KEY_ENCRYPTION_KEY`（Bug 3）
**文件**：[server/.env.example](file:///workspace/server/.env.example)
- **What**：在 `JWT_SECRET` 区块后追加 `API_KEY_ENCRYPTION_KEY` 变量及说明注释。
- **Why**：修复 Bug 1 后该变量成为保存供应商的硬性依赖，模板必须明示，否则部署方易遗漏。
- **How**：新增类似：
  ```
  # AI 供应商 API Key 加密密钥（AES-256-GCM 的 KEK，用于加密落库 ai_providers.api_key）
  # 必须替换为随机强值，长度 >= 16；缺失则保存供应商时会 500
  API_KEY_ENCRYPTION_KEY=changeme-generate-a-strong-kek
  ```
  放在 `JWT_SECRET` 与「AI 配置」注释之间。

## Verification Steps

1. **加密写入验证**：
   - 启动后端（配置 `API_KEY_ENCRYPTION_KEY`），登录管理后台新增一个 AI 供应商（填任意 apiKey）。
   - 直连 MySQL 执行 `SELECT id, api_key FROM ai_providers;`，确认 `api_key` 形如 `base64:base64:base64`（三段冒号分隔），**不再是明文**。
   - 在后台编辑该供应商但不改 Key（留空保存），再次查库确认仍为密文（且能正常被 `decrypt` 还原调用）。
   - 调用 AI 测试或对局触发 LLM，确认解密链路正常工作（OpenAI/Anthropic/Gemini 任一）。
2. **角色鉴权验证**：
   - 重新跑 `node server/seed.js`（开发环境），用 `admin` 登录。
   - 进入 admin-ai.html，对任一模型点「测试」并提交 prompt，确认**不再返回 403**，能正常发起测试调用（或返回上游业务错误如 401/余额不足，而非 403 权限不足）。
   - 确认侧边栏 `#admin-role` 显示「超级管理员」而非「superadmin」。
3. **配置守卫验证**：
   - 清空 `API_KEY_ENCRYPTION_KEY` 重启，确认启动日志有 warn；随后新增供应商应返回 500（fail-loud），不静默写入明文。
4. **回归**：admin-puzzles / admin-dashboard 页面侧边栏管理员信息（头像首字母、姓名、角色）正常显示；登出仍可正常吊销 token。

## Out of Scope
- 历史明文 Key 的批量迁移脚本（用户确认开发阶段无需）。
- 管理后台 XSS 加固（经核实已是误报，现有 `Helpers.escape()` 覆盖完整）。
- Spec 中已落地的其余安全项（helmet/限流/SSRF/tokenVersion 等）不再回改。
