// Redis 缓存封装（可选依赖：未配置或不可用时自动降级直查 DB）
const Redis = require('ioredis');
const config = require('./config');

const PREFIX = config.redis.keyPrefix;

// 是否显式禁用：REDIS_URL 与 REDIS_HOST 均未设置时，根本不创建客户端
const explicitlyDisabled = !config.redis.url && !process.env.REDIS_HOST;

let client = null;
let ready = false;

function log(...args) {
  console.log('[redis]', ...args);
}
function warn(...args) {
  console.warn('[redis]', ...args);
}

function createClient(role) {
  const opts = {
    // 离线时命令立即失败而非排队，确保降级路径快速返回
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      // 指数退避，上限 30s
      return Math.min(times * 500, 30000);
    },
    lazyConnect: true,
  };
  if (config.redis.url) {
    return new Redis(config.redis.url, opts);
  }
  return new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    db: config.redis.db,
    ...opts,
  });
}

function init() {
  if (explicitlyDisabled) {
    warn('未配置 REDIS_URL / REDIS_HOST，缓存功能已禁用（直查 DB）');
    return;
  }
  client = createClient('main');
  client.on('ready', () => {
    if (!ready) log('连接就绪，缓存已启用');
    ready = true;
  });
  client.on('error', (err) => {
    // ioredis 默认会重连，这里仅记录
    warn('连接错误:', err.message);
  });
  client.on('close', () => {
    if (ready) warn('连接关闭，缓存降级');
    ready = false;
  });
  client.on('reconnecting', (delay) => {
    warn(`重连中，${delay}ms 后重试`);
  });
  // 触发惰性连接
  client.connect().catch((err) => {
    warn('初始连接失败:', err.message, '— 服务将以降级模式启动');
  });
}

function getClient() {
  return client;
}

function isAvailable() {
  return !!(client && ready);
}

// ===== 基础操作 =====

async function get(key) {
  if (!isAvailable()) return null;
  try {
    const raw = await client.get(PREFIX + key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (err) {
    warn('get 失败:', key, err.message);
    return null;
  }
}

async function set(key, value, ttlSec) {
  if (!isAvailable()) return false;
  try {
    const raw = JSON.stringify(value);
    if (ttlSec && ttlSec > 0) {
      await client.set(PREFIX + key, raw, 'EX', ttlSec);
    } else {
      await client.set(PREFIX + key, raw);
    }
    return true;
  } catch (err) {
    warn('set 失败:', key, err.message);
    return false;
  }
}

async function del(key) {
  if (!isAvailable()) return 0;
  try {
    return await client.del(PREFIX + key);
  } catch (err) {
    warn('del 失败:', key, err.message);
    return 0;
  }
}

// 用 SCAN 删除匹配前缀的所有 key（避免 KEYS 阻塞）
// 注意：传入的 prefix 是不带全局前缀的逻辑前缀，如 'ai:*'
async function delByPrefix(logicalPrefix) {
  if (!isAvailable()) return 0;
  try {
    const fullPattern = PREFIX + logicalPrefix;
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await client.scan(
        cursor, 'MATCH', fullPattern, 'COUNT', 200
      );
      cursor = next;
      if (keys.length > 0) {
        deleted += await client.del(...keys);
      }
    } while (cursor !== '0');
    return deleted;
  } catch (err) {
    warn('delByPrefix 失败:', logicalPrefix, err.message);
    return 0;
  }
}

/**
 * Read-through 封装：cache miss 时执行 loader 取值并回填
 * - loader 返回 null/undefined 时不写入缓存（避免缓存"不存在"导致后续创建被误判）
 * - Redis 不可用时直接执行 loader
 */
async function getOrSet(key, ttlSec, loader) {
  const cached = await get(key);
  if (cached !== null) return cached;
  const fresh = await loader();
  if (fresh !== null && fresh !== undefined) {
    await set(key, fresh, ttlSec);
  }
  return fresh;
}

async function invalidateAiConfigCache() {
  return delByPrefix('ai:*');
}

async function shutdown() {
  if (client) {
    try { await client.quit(); } catch (_) {}
    client = null;
    ready = false;
  }
}

module.exports = {
  init,
  getClient,
  isAvailable,
  get,
  set,
  del,
  delByPrefix,
  getOrSet,
  invalidateAiConfigCache,
  shutdown,
  // 暴露 createClient 供 Socket.IO adapter 复用连接配置
  createClient,
};
