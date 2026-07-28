const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { adminAuth } = require('../middleware/adminAuth');
const aiConfig = require('../services/aiConfigService');
const aiRouter = require('../services/aiRouter');

const router = express.Router();

const FORMAT_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

// ==================== 供应商 ====================

// GET /api/admin/ai/providers
router.get('/admin/ai/providers', adminAuth, (req, res) => {
  res.json({ items: aiConfig.listProviders(true) });
});

// POST /api/admin/ai/providers
router.post('/admin/ai/providers', adminAuth, (req, res) => {
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
  const id = uuidv4();
  db.prepare(`
    INSERT INTO ai_providers (id, name, format, base_url, api_key, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), format, finalBaseUrl, apiKey || '', enabled === false ? 0 : 1, sortOrder || 0);
  res.json({ provider: aiConfig.listProviders().find((p) => p.id === id) });
});

// PUT /api/admin/ai/providers/:id
router.put('/admin/ai/providers/:id', adminAuth, (req, res) => {
  const existing = aiConfig.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  const { name, format, baseUrl, apiKey, enabled, sortOrder } = req.body || {};
  if (format && !aiConfig.VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: '格式必须为 openai / anthropic / gemini' });
  }
  const newApiKey = apiKey === undefined || apiKey === '' ? existing.apiKey : apiKey;
  db.prepare(`
    UPDATE ai_providers SET name = ?, format = ?, base_url = ?, api_key = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    format ?? existing.format,
    (baseUrl || existing.baseUrl).trim(),
    newApiKey,
    enabled === undefined ? (existing.enabled ? 1 : 0) : (enabled ? 1 : 0),
    sortOrder ?? existing.sortOrder,
    req.params.id
  );
  res.json({ provider: aiConfig.listProviders().find((p) => p.id === req.params.id) });
});

// DELETE /api/admin/ai/providers/:id
router.delete('/admin/ai/providers/:id', adminAuth, (req, res) => {
  const existing = aiConfig.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: '供应商不存在' });
  // ON DELETE CASCADE 会自动删除其下模型；模型被删后角色绑定也会级联
  db.prepare(`DELETE FROM ai_providers WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ==================== 模型 ====================

// GET /api/admin/ai/models?providerId=
router.get('/admin/ai/models', adminAuth, (req, res) => {
  res.json({ items: aiConfig.listModels(req.query.providerId) });
});

// POST /api/admin/ai/models
router.post('/admin/ai/models', adminAuth, (req, res) => {
  const { providerId, name, modelId, contextWindow, maxOutput, modalities, enabled, sortOrder } = req.body || {};
  if (!providerId || !name || !modelId) {
    return res.status(400).json({ error: '所属供应商、显示名称、模型 ID 均为必填' });
  }
  if (!aiConfig.getProvider(providerId)) {
    return res.status(400).json({ error: '所属供应商不存在' });
  }
  const id = uuidv4();
  const modalitiesJson = JSON.stringify(Array.isArray(modalities) && modalities.length > 0 ? modalities : ['text']);
  db.prepare(`
    INSERT INTO ai_models (id, provider_id, name, model_id, context_window, max_output, modalities, enabled, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, providerId, name.trim(), modelId.trim(),
    contextWindow || 128000, maxOutput || 4096, modalitiesJson,
    enabled === false ? 0 : 1, sortOrder || 0
  );
  res.json({ model: aiConfig.listModels().find((m) => m.id === id) });
});

// PUT /api/admin/ai/models/:id
router.put('/admin/ai/models/:id', adminAuth, (req, res) => {
  const existing = db.prepare(`SELECT * FROM ai_models WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '模型不存在' });
  const { providerId, name, modelId, contextWindow, maxOutput, modalities, enabled, sortOrder } = req.body || {};
  if (providerId && !aiConfig.getProvider(providerId)) {
    return res.status(400).json({ error: '所属供应商不存在' });
  }
  const modalitiesJson = Array.isArray(modalities) ? JSON.stringify(modalities) : existing.modalities;
  db.prepare(`
    UPDATE ai_models SET provider_id = ?, name = ?, model_id = ?, context_window = ?, max_output = ?, modalities = ?, enabled = ?, sort_order = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    providerId ?? existing.provider_id,
    name ?? existing.name,
    modelId ?? existing.model_id,
    contextWindow ?? existing.context_window,
    maxOutput ?? existing.max_output,
    modalitiesJson,
    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    sortOrder ?? existing.sort_order,
    req.params.id
  );
  res.json({ model: aiConfig.listModels().find((m) => m.id === req.params.id) });
});

// DELETE /api/admin/ai/models/:id
router.delete('/admin/ai/models/:id', adminAuth, (req, res) => {
  const existing = db.prepare(`SELECT id FROM ai_models WHERE id = ?`).get(req.params.id);
  if (!existing) return res.status(404).json({ error: '模型不存在' });
  db.prepare(`DELETE FROM ai_models WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ==================== 角色 ====================

// GET /api/admin/ai/roles
router.get('/admin/ai/roles', adminAuth, (req, res) => {
  res.json({ items: aiConfig.listRoles() });
});

// POST /api/admin/ai/roles
router.post('/admin/ai/roles', adminAuth, (req, res) => {
  const { roleKey, name, description, pollingStrategy, enabled } = req.body || {};
  if (!roleKey || !name) {
    return res.status(400).json({ error: 'role_key 与名称均为必填' });
  }
  if (!/^[a-z][a-z0-9_]*$/.test(roleKey)) {
    return res.status(400).json({ error: 'role_key 必须以小写字母开头，仅含小写字母/数字/下划线' });
  }
  if (db.prepare(`SELECT id FROM ai_roles WHERE role_key = ?`).get(roleKey)) {
    return res.status(400).json({ error: 'role_key 已存在' });
  }
  if (pollingStrategy && !aiConfig.VALID_STRATEGIES.includes(pollingStrategy)) {
    return res.status(400).json({ error: 'polling_strategy 必须为 ' + aiConfig.VALID_STRATEGIES.join(' / ') });
  }
  const id = uuidv4();
  db.prepare(`
    INSERT INTO ai_roles (id, role_key, name, description, is_builtin, polling_strategy, enabled)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(id, roleKey, name.trim(), description || '', pollingStrategy || 'round_robin', enabled === false ? 0 : 1);
  res.json({ role: aiConfig.getRoleById(id) });
});

// PUT /api/admin/ai/roles/:id
router.put('/admin/ai/roles/:id', adminAuth, (req, res) => {
  const existing = aiConfig.getRoleById(req.params.id);
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
    const dup = db.prepare(`SELECT id FROM ai_roles WHERE role_key = ? AND id != ?`).get(roleKey, req.params.id);
    if (dup) return res.status(400).json({ error: 'role_key 已存在' });
  }
  db.prepare(`
    UPDATE ai_roles SET name = ?, description = ?, polling_strategy = ?, enabled = ?, role_key = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name ?? existing.name,
    description ?? existing.description,
    pollingStrategy ?? existing.pollingStrategy,
    enabled === undefined ? (existing.enabled ? 1 : 0) : (enabled ? 1 : 0),
    (existing.isBuiltin ? existing.roleKey : (roleKey || existing.roleKey)),
    req.params.id
  );
  res.json({ role: aiConfig.getRoleById(req.params.id) });
});

// DELETE /api/admin/ai/roles/:id
router.delete('/admin/ai/roles/:id', adminAuth, (req, res) => {
  const existing = aiConfig.getRoleById(req.params.id);
  if (!existing) return res.status(404).json({ error: '角色不存在' });
  if (existing.isBuiltin) {
    return res.status(400).json({ error: '内置角色不可删除' });
  }
  db.prepare(`DELETE FROM ai_roles WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ==================== 角色-模型绑定 ====================

// GET /api/admin/ai/roles/:id/models
router.get('/admin/ai/roles/:id/models', adminAuth, (req, res) => {
  const role = aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  res.json({ items: aiConfig.getRoleBindingsAdmin(req.params.id) });
});

// PUT /api/admin/ai/roles/:id/models  — 整体替换绑定列表
router.put('/admin/ai/roles/:id/models', adminAuth, (req, res) => {
  const role = aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  const bindings = Array.isArray(req.body) ? req.body : (req.body.bindings || []);
  // 校验
  for (const b of bindings) {
    if (!b.modelId) return res.status(400).json({ error: '绑定项缺少 modelId' });
    const m = db.prepare(`SELECT id FROM ai_models WHERE id = ?`).get(b.modelId);
    if (!m) return res.status(400).json({ error: `模型 ${b.modelId} 不存在` });
  }
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ai_role_models WHERE role_id = ?`).run(req.params.id);
    const stmt = db.prepare(`
      INSERT INTO ai_role_models (id, role_id, model_id, priority, weight, enabled, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    bindings.forEach((b, idx) => {
      stmt.run(
        uuidv4(), req.params.id, b.modelId,
        b.priority || 0, b.weight || 1,
        b.enabled === false ? 0 : 1,
        b.sortOrder != null ? b.sortOrder : idx
      );
    });
  });
  tx();
  res.json({ items: aiConfig.getRoleBindingsAdmin(req.params.id) });
});

// PATCH /api/admin/ai/roles/:id/strategy
router.patch('/admin/ai/roles/:id/strategy', adminAuth, (req, res) => {
  const role = aiConfig.getRoleById(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  const { strategy } = req.body || {};
  if (!aiConfig.VALID_STRATEGIES.includes(strategy)) {
    return res.status(400).json({ error: 'strategy 必须为 ' + aiConfig.VALID_STRATEGIES.join(' / ') });
  }
  db.prepare(`UPDATE ai_roles SET polling_strategy = ?, updated_at = datetime('now') WHERE id = ?`).run(strategy, req.params.id);
  res.json({ role: aiConfig.getRoleById(req.params.id) });
});

// ==================== 测试 ====================

// POST /api/admin/ai/test  { modelId, prompt }
router.post('/admin/ai/test', adminAuth, async (req, res) => {
  const { modelId, prompt } = req.body || {};
  if (!modelId || !prompt) {
    return res.status(400).json({ error: 'modelId 与 prompt 均为必填' });
  }
  try {
    const content = await aiRouter.testModel(modelId, prompt);
    res.json({ ok: true, content });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
