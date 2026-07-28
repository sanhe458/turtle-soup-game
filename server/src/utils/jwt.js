const jwt = require('jsonwebtoken');
const config = require('../config');

function signUser(payload) {
  return jwt.sign({ ...payload, type: 'user' }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

function signAdmin(payload) {
  return jwt.sign({ ...payload, type: 'admin' }, config.jwtSecret, {
    expiresIn: config.adminJwtExpiresIn,
  });
}

function verify(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { signUser, signAdmin, verify };
