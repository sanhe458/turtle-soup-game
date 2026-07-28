const { verify } = require('../utils/jwt');
const db = require('../db');

function adminAuth(req, res, next) {
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
    const admin = db
      .prepare('SELECT id, token_version FROM admins WHERE id = ?')
      .get(decoded.id);
    if (!admin) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    if (admin.token_version !== decoded.tokenVersion) {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    req.admin = { id: admin.id, account: decoded.account, name: decoded.name, role: decoded.role };
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
