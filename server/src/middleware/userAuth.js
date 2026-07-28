const { verify } = require('../utils/jwt');
const db = require('../db');
const redis = require('../redis');

async function userAuth(req, res, next) {
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
    // token_version 读穿透缓存：TTL 60s 兜底，登出时主动 del
    const cached = await redis.getOrSet(
      `auth:u:${decoded.userId}`,
      60,
      async () => {
        const u = await db.getOne(
          'SELECT id, token_version FROM users WHERE id = ?',
          [decoded.userId]
        );
        if (!u) return null; // 不缓存 null，避免新建用户短时被误判
        return { tokenVersion: u.token_version };
      }
    );
    if (!cached) {
      return res.status(401).json({ error: '身份凭证无效或已过期' });
    }
    if (cached.tokenVersion !== decoded.tokenVersion) {
      return res.status(401).json({ error: '身份凭证无效或已过期' });
    }
    req.user = { userId: decoded.userId, nickname: decoded.nickname };
    next();
  } catch (err) {
    return res.status(401).json({ error: '身份凭证无效或已过期' });
  }
}

// 可选鉴权：有 token 就解析，没有也放行；token 失效或已撤销则视同未登录
async function optionalUserAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) {
    try {
      const decoded = verify(token);
      if (decoded.type === 'user') {
        const cached = await redis.getOrSet(
          `auth:u:${decoded.userId}`,
          60,
          async () => {
            const u = await db.getOne(
              'SELECT id, token_version FROM users WHERE id = ?',
              [decoded.userId]
            );
            if (!u) return null;
            return { tokenVersion: u.token_version };
          }
        );
        if (cached && cached.tokenVersion === decoded.tokenVersion) {
          req.user = { userId: decoded.userId, nickname: decoded.nickname };
        }
      }
    } catch {
      // 忽略无效 token
    }
  }
  next();
}

module.exports = { userAuth, optionalUserAuth };
