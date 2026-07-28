const jwt = require('jsonwebtoken');
const config = require('../config');

function signUser(userId, nickname, tokenVersion) {
  return jwt.sign(
    { userId, nickname, tokenVersion, type: 'user' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

function signAdmin(id, account, name, role, tokenVersion) {
  return jwt.sign(
    { id, account, name, role, tokenVersion, type: 'admin' },
    config.jwtSecret,
    { expiresIn: config.adminJwtExpiresIn }
  );
}

function verify(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

module.exports = { signUser, signAdmin, verify };
