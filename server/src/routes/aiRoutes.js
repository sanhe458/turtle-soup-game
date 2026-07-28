const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { adminAuth, requireRole } = require('../middleware/adminAuth');
const aiConfig = require('../services/aiConfigService');
const aiRouter = require('../services/aiRouter');

const router = express.Router();

const FORMAT_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

// SSRF 防护：校验 baseUrl，禁止内网/回环/链路本地地址
function validateBaseUrl(url) {
  if (!url) return { ok: false, error: 'baseUrl 不能为空' };
  let parsed;
  try { parsed = new URL(url); } catch (e) { return { ok: false, error: 'baseUrl 格式非法' }; }
  // Allow https always; allow http only in non-production
  if (parsed.protocol === 'http:' && process.env.NODE_ENV === 'production') {
    return { ok: false, error: '生产环境 baseUrl 必须使用 https' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'baseUrl 协议必须是 http 或 https' };
  }
  const host = parsed.hostname;
  // Block private/loopback/link-local addresses
  const blocked = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|localhost|::1$|fc|fd)/i;
  if (blocked.test(host)) {
    return { ok: false, error: '不允许的地址：禁止内网/回环/链路本地地址' };
  }
  return { ok: true };
}

// 数值字段校验：仅接受有限数
function toFiniteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 测试调用限流：每分钟 10 次
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '测试调用过于频繁' },
});

// ==================== 供应商 ====================

// GET /api/admin/ai/providers
router.get('/admin/ai/providers', adminAuth, async (req, res) => {
  res.json({ items: await aiConfig.listProviders(true) });
});

// POST /api/admin/ai/providers
router.post('/admin/ai/providers', adminAuth, async (req, res) => {
  const { name, format, baseUrl, apiKey, enabled, sortOrder } = req.body || {};
  if (!name || !format) {
    return res.status(400).json({ error: '名称与协议格式均为必填' });
  }
  if (!aiConfig.VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: '格式必须为 openai / anthropic / gemini' });
  }
  const finalBaseUrl = (baseUrl || FORMAT_DEFAULTS[format] || '').trim();
  if (!finalBaseUrl) {
    return res.status(400).json({ error: 'Base URL 不能为空' });
  }
  const urlCheck = validateBaseUrl(finalBaseUrl);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.error });
  }
  const id = uuidv4();
  await db.run(`
    INSERT INTO ai_providers (id, name, format, base_url, api_key, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, name.trim(), format, finalBaseUrl, apiKey || '', enabled === false ? 0 : 1, toFiniteNumber(sortOrder, 0)]);
  await aiConfig.invalidateAiConfigCache();
  const providers = await aiConfig.listProviders();
  res.json({ provider: providers.find((p) => p.id === id) });
});

// PUT /api/admin/ai/providers/:id
router.put('/admin/ai/providers/:id', adminAuth, async (req, res) => {
  const existing = await aiConfig.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  const { name, format, baseUrl, apiKey, enabled, sortOrder } = req.body || {};
  if (format && !aiConfig.VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: '格式必须为 openai / anthropic / gemini' });
  }
  const newApiKey = apiKey === undefined || apiKey === '' ? existing.apiKey : apiKey;
  const finalBaseUrl = (baseUrl || existing.baseUrl).trim();
  const urlCheck = validateBaseUrl(finalBaseUrl);
  if (!urlCheck.ok) {
    return res.status(400).json({ error: urlCheck.error });
  }
  await db.run(`
    UPDATE ai_providers SET name = ?, format = ?, base_url = ?, api_key = ?, enabled = ?, sort_order = ?, updated_at = NOW()
    WHERE id = ?
  `, [
    name ?? existing.name,
    format ?? existing.format,
    finalBaseUrl,
    newApiKey,
    enabled === undefined ? (existing.enabled ? 1 : 0) : (enabled ? 1 : 0),
    toFiniteNumber(sortOrder ?? existing.sortOrder, existing.sortOrder || 0),
    req.params.id,
  ]);
  await aiConfig.invalidateAiConfigCache();
  const providers = await aiConfig.listProviders();
  res.json({ provider: providers.find((p) => p.id === req.params.id) });
});

// DELETE /api/admin/ai/providers/:id
router.delete('/admin/ai/providers/:id', adminAuth, async (req, res) => {
  const existing = await aiConfig.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  // ON DELETE CASCADE 会自动删除其下模型；模型被删后角色绑定也会级联
  await db.run(`DELETE FROM ai_providers WHERE id = ?`, [req.params.id]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ ok: true });
});

// ==================== 模型 ====================

// GET /api/admin/ai/models?providerId=
router.get('/admin/ai/models', adminAuth, async (req, res) => {
  res.json({ items: await aiConfig.listModels(req.query.providerId) });
});

// POST /api/admin/ai/models
router.post('/admin/ai/models', adminAuth, async (req, res) => {
  const { providerId, name, modelId, contextWindow, maxOutput, modalities, enabled, sortOrder } = req.body || {};
  if (!providerId || !name || !modelId) {
    return res.status(400).json({ error: '所属供应商、显示名称、模型 ID 均为必填' });
  }
  if (!(await aiConfig.getProvider(providerId))) {
    return res.status(400).json({ error: '所属供应商不存在' });
  }
  const id = uuidv4();
  const modalitiesJson = JSON.stringify(Array.isArray(modalities) && modalities.length > 0 ? modalities : ['text']);
  await db.run(`
    INSERT INTO ai_models (id, provider_id, name, model_id, context_window, max_output, modalities, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id, providerId, name.trim(), modelId.trim(),
    contextWindow || 128000, maxOutput || 4096, modalitiesJson,
    enabled === false ? 0 : 1, toFiniteNumber(sortOrder, 0),
  ]);
  await aiConfig.invalidateAiConfigCache();
  const models = await aiConfig.listModels();
  res.json({ model: models.find((m) => m.id === id) });
});

// PUT /api/admin/ai/models/:id
router.put('/admin/ai/models/:id', adminAuth, async (req, res) => {
  const existing = await db.getOne(`SELECT * FROM ai_models WHERE id = ?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: '模型不存在' });
  const { providerId, name, modelId, contextWindow, maxOutput, modalities, enabled, sortOrder } = req.body || {};
  if (providerId && !(await aiConfig.getProvider(providerId))) {
    return res.status(400).json({ error: '所属供应商不存在' });
  }
  const modalitiesJson = Array.isArray(modalities) ? JSON.stringify(modalities) : existing.modalities;
  await db.run(`
    UPDATE ai_models SET provider_id = ?, name = ?, model_id = ?, context_window = ?, max_output = ?, modalities = ?, enabled = ?, sort_order = ?, updated_at = NOW()
    WHERE id = ?
  `, [
    providerId ?? existing.provider_id,
    name ?? existing.name,
    modelId ?? existing.model_id,
    contextWindow ?? existing.context_window,
    maxOutput ?? existing.max_output,
    modalitiesJson,
    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    toFiniteNumber(sortOrder ?? existing.sort_order, existing.sort_order || 0),
    req.params.id,
  ]);
  await aiConfig.invalidateAiConfigCache();
  const models = await aiConfig.listModels();
  res.json({ model: models.find((m) => m.id === req.params.id) });
});

// DELETE /api/admin/ai/models/:id
router.delete('/admin/ai/models/:id', adminAuth, async (req, res) => {
  const existing = await db.getOne(`SELECT id FROM ai_models WHERE id = ?`, [req.params.id]);
  if (!existing) return res.status(404).json({ error: '模型不存在' });
  await db.run(`DELETE FROM ai_models WHERE id = ?`, [req.params.id]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ ok: true });
});

// ==================== 角色 ====================

// GET /api/admin/ai/roles
router.get('/admin/ai/roles', adminAuth, async (req, res) => {
  res.json({ items: await aiConfig.listRoles() });
});

// POST /api/admin/ai/roles
router.post('/admin/ai/roles', adminAuth, async (req, res) => {
  const { roleKey, name, description, pollingStrategy, enabled } = req.body || {};
  if (!roleKey || !name) {
    return res.status(400).json({ error: 'role_key 与名称均为必填' });
  }
  if (!/^[a-z][a-z0-9_]*$/.test(roleKey)) {
    return res.status(400).json({ error: 'role_key 必须以小写字母开头，仅含小写字母/数字/下划线' });
  }
  if (await db.getOne(`SELECT id FROM ai_roles WHERE role_key = ?`, [roleKey])) {
    return res.status(400).json({ error: 'role_key 已存在' });
  }
  if (pollingStrategy && !aiConfig.VALID_STRATEGIES.includes(pollingStrategy)) {
    return res.status(400).json({ error: 'polling_strategy 必须为 ' + aiConfig.VALID_STRATEGIES.join(' / ') });
  }
  const id = uuidv4();
  await db.run(`
    INSERT INTO ai_roles (id, role_key, name, description, is_builtin, polling_strategy, enabled)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `, [id, roleKey, name.trim(), description || '', pollingStrategy || 'round_robin', enabled === false ? 0 : 1]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ role: await aiConfig.getRoleById(id) });
});

// PUT /api/admin/ai/roles/:id
router.put('/admin/ai/roles/:id', adminAuth, async (req, res) => {
  const existing = await aiConfig.getRoleById(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  const { name, description, pollingStrategy, enabled, roleKey } = req.body || {};
  if (pollingStrategy && !aiConfig.VALID_STRATEGIES.includes(pollingStrategy)) {
    return res.status(400).json({ error: 'polling_strategy 必须为 ' + aiConfig.VALID_STRATEGIES.join(' / ') });
  }
  // role_key 仅非内置角色可改，且需唯一
  if (roleKey && !existing.isBuiltin) {
    if (!/^[a-z][a-z0-9_]*$/.test(roleKey)) {
      return res.status(400).json({ error: 'role_key 必须以小写字母开头，仅含小写字母/数字/下划线' });
    }
    const dup = await db.getOne(`SELECT id FROM ai_roles WHERE role_key = ? AND id != ?`, [roleKey, req.params.id]);
    if (dup) return res.status(400).json({ error: 'role_key 已存在' });
  }
  await db.run(`
    UPDATE ai_roles SET name = ?, description = ?, polling_strategy = ?, enabled = ?, role_key = ?, updated_at = NOW()
    WHERE id = ?
  `, [
    name ?? existing.name,
    description ?? existing.description,
    pollingStrategy ?? existing.pollingStrategy,
    enabled === undefined ? (existing.enabled ? 1 : 0) : (enabled ? 1 : 0),
    (existing.isBuiltin ? existing.roleKey : (roleKey || existing.roleKey)),
    req.params.id,
  ]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ role: await aiConfig.getRoleById(req.params.id) });
});

// DELETE /api/admin/ai/roles/:id
router.delete('/admin/ai/roles/:id', adminAuth, async (req, res) => {
  const existing = await aiConfig.getRoleById(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  if (existing.isBuiltin) {
    return res.status(400).json({ error: '内置角色不可删除' });
  }
  await db.run(`DELETE FROM ai_roles WHERE id = ?`, [req.params.id]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ ok: true });
});

// ==================== 角色-模型绑定 ====================

// GET /api/admin/ai/roles/:id/models
router.get('/admin/ai/roles/:id/models', adminAuth, async (req, res) => {
  const role = await aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  res.json({ items: await aiConfig.getRoleBindingsAdmin(req.params.id) });
});

// PUT /api/admin/ai/roles/:id/models  — 整体替换绑定列表
router.put('/admin/ai/roles/:id/models', adminAuth, async (req, res) => {
  const role = await aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  const bindings = Array.isArray(req.body) ? req.body : (req.body.bindings || []);
  // 校验
  for (const b of bindings) {
    if (!b.modelId) return res.status(400).json({ error: '绑定项缺少 modelId' });
    const m = await db.getOne(`SELECT id FROM ai_models WHERE id = ?`, [b.modelId]);
    if (!m) return res.status(400).json({ error: `模型 ${b.modelId} 不存在` });
  }
  await db.withTransaction(async (conn) => {
    await conn.execute(`DELETE FROM ai_role_models WHERE role_id = ?`, [req.params.id]);
    for (let idx = 0; idx < bindings.length; idx++) {
      const b = bindings[idx];
      await conn.execute(
        `INSERT INTO ai_role_models (id, role_id, model_id, priority, weight, enabled, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(), req.params.id, b.modelId,
          toFiniteNumber(b.priority, 0), toFiniteNumber(b.weight, 1),
          b.enabled === false ? 0 : 1,
          toFiniteNumber(b.sortOrder != null ? b.sortOrder : idx, idx),
        ]
      );
    }
  });
  await aiConfig.invalidateAiConfigCache();
  res.json({ items: await aiConfig.getRoleBindingsAdmin(req.params.id) });
});

// PATCH /api/admin/ai/roles/:id/strategy
router.patch('/admin/ai/roles/:id/strategy', adminAuth, async (req, res) => {
  const role = await aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  const { strategy } = req.body || {};
  if (!aiConfig.VALID_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: 'strategy 必须为 ' + aiConfig.VALID_STRATEGIES.join(' / ') });
  }
  await db.run(`UPDATE ai_roles SET polling_strategy = ?, updated_at = NOW() WHERE id = ?`, [strategy, req.params.id]);
  await aiConfig.invalidateAiConfigCache();
  res.json({ role: await aiConfig.getRoleById(req.params.id) });
});

// ==================== 测试 ====================

// POST /api/admin/ai/test  { modelId, prompt }
router.post('/admin/ai/test', adminAuth, requireRole('superadmin'), testLimiter, async (req, res) => {
  const { modelId, prompt } = req.body || {};
  if (!modelId || !prompt) {
    return res.status(400).json({ error: 'modelId 与 prompt 均为必填' });
  }
  if (typeof prompt !== 'string' || prompt.length > 2000) {
    return res.status(400).json({ error: 'prompt 长度不能超过 2000 字符' });
  }
  try {
    const content = await aiRouter.testModel(modelId, prompt);
    res.json({ ok: true, content });
  } catch (err) {
    console.error('[aiRoutes] testModel 失败:', err.message);
    res.status(502).json({ ok: false, error: '供应商调用失败，请查看服务端日志' });
  }
});

module.exports = router;
