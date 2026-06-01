const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/magizhchi_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-that-is-long-enough';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-only-refresh-secret-that-is-long-enough';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
process.env.COOKIE_EXPIRES_IN = process.env.COOKIE_EXPIRES_IN || '1';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

test('Express application loads', () => {
  const app = require('../app');

  assert.equal(typeof app, 'function');
});
