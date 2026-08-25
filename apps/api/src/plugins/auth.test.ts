import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'

describe('Auth plugin', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('health endpoint works with dev-mode auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: 'Bearer dev-token' }
    })
    expect(res.statusCode).toBe(200)
  })

  it('health endpoint works without auth header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
  })
})
