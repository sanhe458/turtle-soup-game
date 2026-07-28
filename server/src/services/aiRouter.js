// AI 路由与调用服务：按角色选择模型 + 适配三种协议格式 + 四种轮询策略
const aiConfig = require('./aiConfigService');

const TIMEOUT_MS = 8000;

// ===== 内存状态 =====
// round_robin: Map<roleKey, nextIndex>
const roundRobinIndex = new Map();
// load_balance: Map<bindingId, inFlightCount>
const inFlightCount = new Map();

// ===== 模型选择 =====

/**
 * 按 polling_strategy 选择一个绑定模型
 * @param {object} roleConfig - getRoleByKey 返回的角色配置
 * @returns {object|null} 选中的绑定模型，或 null（无可用模型）
 */
function selectModel(roleConfig) {
  const models = (roleConfig.models || []).filter((m) => m.enabled !== false);
  if (models.length === 0) return null;

  switch (roleConfig.pollingStrategy) {
    case 'round_robin':
      return selectRoundRobin(roleConfig.roleKey, models);
    case 'failover':
      // failover 由 callRole 内部循环处理，这里返回第一个（按 priority 升序，getRoleBindings 已按 sort_order,priority 排序）
      return sortByPriority(models)[0];
    case 'weighted_random':
      return selectWeightedRandom(models);
    case 'load_balance':
      return selectLoadBalance(models);
    default:
      return models[0];
  }
}

function selectRoundRobin(roleKey, models) {
  const sorted = models.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  if (sorted.length === 0) return null;
  const idx = roundRobinIndex.get(roleKey) || 0;
  const pick = sorted[idx % sorted.length];
  roundRobinIndex.set(roleKey, (idx + 1) % sorted.length);
  return pick;
}

function sortByPriority(models) {
  return models.slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
}

function selectWeightedRandom(models) {
  const total = models.reduce((s, m) => s + Math.max(1, m.weight || 1), 0);
  let r = Math.random() * total;
  for (const m of models) {
    r -= Math.max(1, m.weight || 1);
    if (r <= 0) return m;
  }
  return models[models.length - 1];
}

function selectLoadBalance(models) {
  const sorted = models.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  let best = sorted[0];
  let bestCount = inFlightCount.get(best.bindingId) || 0;
  for (let i = 1; i < sorted.length; i++) {
    const c = inFlightCount.get(sorted[i].bindingId) || 0;
    if (c < bestCount) {
      best = sorted[i];
      bestCount = c;
    }
  }
  return best;
}

function incInFlight(bindingId) {
  inFlightCount.set(bindingId, (inFlightCount.get(bindingId) || 0) + 1);
}
function decInFlight(bindingId) {
  const c = (inFlightCount.get(bindingId) || 0) - 1;
  if (c <= 0) inFlightCount.delete(bindingId);
  else inFlightCount.set(bindingId, c);
}

// ===== 协议适配 =====

async function callProvider(binding, messages, opts = {}) {
  const { provider, modelIdStr } = binding;
  if (!provider.apiKey) {
    throw new Error(`供应商 ${provider.id} 未配置 API Key`);
  }
  switch (provider.format) {
    case 'openai':
      return callOpenAI(provider, modelIdStr, messages, opts);
    case 'anthropic':
      return callAnthropic(provider, modelIdStr, messages, opts);
    case 'gemini':
      return callGemini(provider, modelIdStr, messages, opts);
    default:
      throw new Error(`不支持的协议格式: ${provider.format}`);
  }
}

async function fetchWithTimeout(url, init, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI 格式：POST {base_url}/chat/completions
async function callOpenAI(provider, modelId, messages, opts) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: modelId,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
  };
  if (opts.maxOutput) body.max_tokens = opts.maxOutput;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI API empty content');
  return content;
}

// Anthropic 格式：POST {base_url}/v1/messages
async function callAnthropic(provider, modelId, messages, opts) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = {
    model: modelId,
    messages,
    max_tokens: opts.maxOutput || 4096,
    temperature: opts.temperature != null ? opts.temperature : 0.3,
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error('Anthropic API empty content');
  return content;
}

// Gemini 格式：POST {base_url}/v1beta/models/{model}:generateContent?key=
async function callGemini(provider, modelId, messages, opts) {
  const url = `${provider.baseUrl.replace(/\/$/, '')}/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
  // OpenAI messages -> Gemini contents
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature != null ? opts.temperature : 0.3,
      maxOutputTokens: opts.maxOutput || 4096,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini API empty content');
  return content;
}

// ===== 顶层入口 =====

/**
 * 按角色调用 AI
 * @param {string} roleKey - 角色 key
 * @param {Array} messages - [{role, content}]
 * @param {object} opts - { temperature, maxOutput, jsonMode }
 * @returns {Promise<string>} 模型回复文本
 */
async function callRole(roleKey, messages, opts = {}) {
  const roleConfig = aiConfig.getRoleByKey(roleKey);
  if (!roleConfig) {
    throw new Error(`未找到角色: ${roleKey}`);
  }
  if (!roleConfig.enabled || !roleConfig.models || roleConfig.models.length === 0) {
    throw new Error(`角色 ${roleKey} 未绑定可用模型`);
  }

  // failover: 依次尝试，失败则下一个
  if (roleConfig.pollingStrategy === 'failover') {
    const ordered = sortByPriority(roleConfig.models);
    let lastErr = null;
    for (const binding of ordered) {
      try {
        return await callProvider(binding, messages, opts);
      } catch (err) {
        lastErr = err;
        console.warn(`[aiRouter] failover: 模型 ${binding.name}(${binding.modelIdStr}) 失败，尝试下一个:`, err.message);
      }
    }
    throw lastErr || new Error('failover: 所有模型均失败');
  }

  // 其他策略：选一个调用，失败直接抛出（由 llmService 降级处理）
  const binding = selectModel(roleConfig);
  if (!binding) throw new Error(`角色 ${roleKey} 无可用模型`);

  if (roleConfig.pollingStrategy === 'load_balance') {
    incInFlight(binding.bindingId);
    try {
      return await callProvider(binding, messages, opts);
    } finally {
      decInFlight(binding.bindingId);
    }
  }

  return callProvider(binding, messages, opts);
}

/** 测试单个模型（管理后台用） */
async function testModel(modelId, prompt) {
  const binding = aiConfig.getModel(modelId);
  if (!binding) throw new Error('模型不存在');
  if (!binding.provider) throw new Error('模型所属供应商不存在');
  // 复用 callProvider，构造一个临时 binding 结构
  return callProvider(
    {
      bindingId: 'test',
      modelIdStr: binding.modelId,
      provider: binding.provider,
    },
    [{ role: 'user', content: prompt }],
    { temperature: 0.3, maxOutput: binding.maxOutput }
  );
}

module.exports = {
  callRole,
  callProvider,
  testModel,
  // 暴露 selectModel 便于测试
  selectModel,
  selectRoundRobin,
  selectWeightedRandom,
  selectLoadBalance,
};
