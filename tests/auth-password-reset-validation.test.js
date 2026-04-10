const test = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const { app } = require('../index')

test('POST /api/auth/forgot-password should reject missing email', async () => {
  const response = await request(app)
    .post('/api/auth/forgot-password')
    .send({})

  assert.equal(response.statusCode, 400)
  assert.equal(response.body?.message, 'Email is required')
})

test('POST /api/auth/reset-password/:token should enforce password length', async () => {
  const response = await request(app)
    .post('/api/auth/reset-password/sample-token')
    .send({ newPassword: 'short' })

  assert.equal(response.statusCode, 400)
  assert.equal(response.body?.message, 'Password must be at least 8 characters long')
})