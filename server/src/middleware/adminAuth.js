const { verify } = require('../utils/jwt');

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
    req.admin = { id: decoded.id, account: decoded.account, name: decoded.name, role: decoded.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

module.exports = { adminAuth };
