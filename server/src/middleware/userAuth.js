const { verify } = require('../utils/jwt');

function userAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: '未提供身份凭证' });
  }
  try {
    const decoded = verify(token);
    if (decoded.type !== 'user') {
      return res.status(401).json({ error: '身份凭证类型错误' });
    }
    req.user = { userId: decoded.userId, nickname: decoded.nickname };
    next();
  } catch (err) {
    return res.status(401).json({ error: '身份凭证无效或已过期' });
  }
}

// 可选鉴权：有 token 就解析，没有也放行
function optionalUserAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const decoded = verify(token);
      if (decoded.type === 'user') {
        req.user = { userId: decoded.userId, nickname: decoded.nickname };
      }
    } catch {
      // 忽略无效 token
    }
  }
  next();
}

module.exports = { userAuth, optionalUserAuth };
