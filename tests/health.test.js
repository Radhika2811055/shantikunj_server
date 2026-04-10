const test = require('node:test')
const assert = require('node:assert/strict')
const request = require('supertest')
const { app } = require('../index')

test('GET / should return service heartbeat', async () => {
  const response = await request(app).get('/')

  assert.equal(response.statusCode, 200)
  assert.match(response.text, /server is running/i)
})
