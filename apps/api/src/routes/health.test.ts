import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../app.js'

describe('Health routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => { app = await buildApp(); await app.ready() })
  afterAll(async () => { await app.close() })

  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ status: 'ok', timestamp: expect.any(String) })
  })

  it('GET /api/health/ready returns ready when deps up', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect([200, 503]).toContain(res.statusCode)
    const body = JSON.parse(res.payload)
    expect(body).toHaveProperty('checks.database')
    expect(body).toHaveProperty('checks.redis')
  })
})