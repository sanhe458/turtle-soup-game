// 安全说明：API Key 使用 AES-256-GCM 加密存储。
// 历史明文 Key 会在读取时通过 decrypt() 的向后兼容逻辑自动透传（未加密的值原样返回）。
// 建议运行迁移脚本 encrypt 历史数据，或通过管理后台重新保存每个供应商以触发加密。

// AI 配置读取服务：从数据库查询 providers / models / roles / 绑定关系
const db = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

const VALID_FORMATS = ['openai', 'anthropic', 'gemini'];
const VALID_STRATEGIES = ['round_robin', 'failover', 'weighted_random', 'load_balance'];

/** API Key 掩码：sk-****后4位 */
function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

function parseModalities(raw) {
  if (!raw) return ['text'];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : ['text'];
  } catch {
    return ['text'];
  }
}

// ===== 供应商 =====

function listProviders(includeDisabled = true) {
  const where = includeDisabled ? '' : 'WHERE enabled = 1';
  const rows = db.prepare(`SELECT * FROM ai_providers ${where} ORDER BY sort_order, created_at`).all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format,
    baseUrl: r.base_url,
    apiKey: maskKey(decrypt(r.api_key)),
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function getProvider(id) {
  const r = db.prepare(`SELECT * FROM ai_providers WHERE id = ?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    format: r.format,
    baseUrl: r.base_url,
    apiKey: decrypt(r.api_key), // 解密后明文，仅内部用
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function providerModelCount(providerId) {
  return db.prepare(`SELECT COUNT(*) as c FROM ai_models WHERE provider_id = ?`).get(providerId).c;
}

// ===== 模型 =====

function listModels(providerId) {
  const params = [];
  let where = '';
  if (providerId) {
    where = 'WHERE m.provider_id = ?';
    params.push(providerId);
  }
  const rows = db.prepare(`
    SELECT m.*, p.name as provider_name, p.format as provider_format
    FROM ai_models m
    JOIN ai_providers p ON p.id = m.provider_id
    ${where}
    ORDER BY m.sort_order, m.created_at
  `).all(...params);
  return rows.map((r) => ({
    id: r.id,
    providerId: r.provider_id,
    providerName: r.provider_name,
    providerFormat: r.provider_format,
    name: r.name,
    modelId: r.model_id,
    contextWindow: r.context_window,
    maxOutput: r.max_output,
    modalities: parseModalities(r.modalities),
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

function getModel(id) {
  const r = db.prepare(`
    SELECT m.*, p.name as provider_name, p.format as provider_format, p.base_url as provider_base_url, p.api_key as provider_api_key, p.enabled as provider_enabled
    FROM ai_models m
    JOIN ai_providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(id);
  if (!r) return null;
  return {
    id: r.id,
    providerId: r.provider_id,
    name: r.name,
    modelId: r.model_id,
    contextWindow: r.context_window,
    maxOutput: r.max_output,
    modalities: parseModalities(r.modalities),
    enabled: !!r.enabled,
    sortOrder: r.sort_order,
    provider: {
      id: r.provider_id,
      name: r.provider_name,
      format: r.provider_format,
      baseUrl: r.provider_base_url,
      apiKey: decrypt(r.provider_api_key),
      enabled: !!r.provider_enabled,
    },
  };
}

// ===== 角色 =====

function listRoles() {
  const rows = db.prepare(`SELECT * FROM ai_roles ORDER BY is_builtin DESC, created_at`).all();
  return rows.map((r) => ({
    id: r.id,
    roleKey: r.role_key,
    name: r.name,
    description: r.description,
    isBuiltin: !!r.is_builtin,
    pollingStrategy: r.polling_strategy,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    modelCount: db.prepare(`SELECT COUNT(*) as c FROM ai_role_models WHERE role_id = ?`).get(r.id).c,
  }));
}

function getRoleById(id) {
  const r = db.prepare(`SELECT * FROM ai_roles WHERE id = ?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    roleKey: r.role_key,
    name: r.name,
    description: r.description,
    isBuiltin: !!r.is_builtin,
    pollingStrategy: r.polling_strategy,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getRoleByKey(roleKey) {
  const r = db.prepare(`SELECT * FROM ai_roles WHERE role_key = ?`).get(roleKey);
  if (!r) return null;
  const role = {
    id: r.id,
    roleKey: r.role_key,
    name: r.name,
    pollingStrategy: r.polling_strategy,
    enabled: !!r.enabled,
  };
  if (!role.enabled) return { ...role, models: [] };
  role.models = getRoleBindings(r.id);
  return role;
}

/**
 * 获取角色绑定的模型列表（含供应商信息），按策略排序
 * - round_robin / load_balance: 按 sort_order
 * - failover: 按 priority 升序
 * - weighted_random: 任意顺序（按 sort_order 保持稳定）
 */
function getRoleBindings(roleId) {
  const rows = db.prepare(`
    SELECT rm.id as binding_id, rm.priority, rm.weight, rm.enabled as rm_enabled, rm.sort_order,
      m.id as model_id, m.model_id, m.name, m.context_window, m.max_output, m.modalities,
      p.id as provider_id, p.format, p.base_url, p.api_key, p.enabled as provider_enabled
    FROM ai_role_models rm
    JOIN ai_models m ON m.id = rm.model_id
    JOIN ai_providers p ON p.id = m.provider_id
    WHERE rm.role_id = ? AND rm.enabled = 1 AND m.enabled = 1 AND p.enabled = 1
    ORDER BY rm.sort_order, rm.priority
  `).all(roleId);
  return rows.map((r) => ({
    bindingId: r.binding_id,
    modelId: r.model_id,
    modelIdStr: r.model_id,
    name: r.name,
    contextWindow: r.context_window,
    maxOutput: r.max_output,
    modalities: parseModalities(r.modalities),
    priority: r.priority,
    weight: r.weight,
    sortOrder: r.sort_order,
    provider: {
      id: r.provider_id,
      format: r.format,
      baseUrl: r.base_url,
      apiKey: decrypt(r.api_key),
    },
  }));
}

/** 角色绑定的模型列表（管理后台展示用，含未启用项与模型详情） */
function getRoleBindingsAdmin(roleId) {
  const rows = db.prepare(`
    SELECT rm.id as binding_id, rm.priority, rm.weight, rm.enabled as rm_enabled, rm.sort_order,
      m.id as model_id, m.model_id, m.name, m.context_window, m.max_output, m.modalities,
      p.name as provider_name, p.format as provider_format
    FROM ai_role_models rm
    JOIN ai_models m ON m.id = rm.model_id
    JOIN ai_providers p ON p.id = m.provider_id
    WHERE rm.role_id = ?
    ORDER BY rm.sort_order
  `).all(roleId);
  return rows.map((r) => ({
    bindingId: r.binding_id,
    modelId: r.model_id,
    modelIdStr: r.model_id,
    name: r.name,
    contextWindow: r.context_window,
    maxOutput: r.max_output,
    modalities: parseModalities(r.modalities),
    priority: r.priority,
    weight: r.weight,
    enabled: !!r.rm_enabled,
    sortOrder: r.sort_order,
    providerName: r.provider_name,
    providerFormat: r.provider_format,
  }));
}

function hasEnabledProvider() {
  return db.prepare(`SELECT COUNT(*) as c FROM ai_providers WHERE enabled = 1 AND api_key != ''`).get().c > 0;
}

module.exports = {
  VALID_FORMATS,
  VALID_STRATEGIES,
  maskKey,
  parseModalities,
  // providers
  listProviders,
  getProvider,
  providerModelCount,
  // models
  listModels,
  getModel,
  // roles
  listRoles,
  getRoleById,
  getRoleByKey,
  getRoleBindings,
  getRoleBindingsAdmin,
  // misc
  hasEnabledProvider,
};
