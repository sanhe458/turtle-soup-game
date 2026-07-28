const { verify } = require('../utils/jwt');
const db = require('../db');
const redis = require('../redis');

async function adminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = verify(token);
    if (decoded.type !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    // token_version 读穿透缓存：TTL 60s 兜底，登出时主动 del
    const cached = await redis.getOrSet(
      `auth:a:${decoded.id}`,
      60,
      async () => {
        const a = await db.getOne(
          'SELECT id, token_version FROM admins WHERE id = ?',
          [decoded.id]
        );
        if (!a) return null;
        return { tokenVersion: a.token_version };
      }
    );
    if (!cached) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    if (cached.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    req.admin = { id: decoded.id, account: decoded.account, name: decoded.name, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// RBAC：要求指定角色
function requireRole(role) {
  return (req, res, next) => {
    if (!req.admin || req.admin.role !== role) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { adminAuth, requireRole };
