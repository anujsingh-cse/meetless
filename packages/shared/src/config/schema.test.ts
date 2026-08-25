import { describe, it, expect } from 'vitest'
import { envSchema } from './schema.js'

describe('envSchema', () => {
  it('parses valid env', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      PORT: '3000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/meetless',
      REDIS_URL: 'redis://localhost:6379'
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.PORT).toBe(3000)
  })

  it('rejects invalid DATABASE_URL', () => {
    const result = envSchema.safeParse({
      NODE_ENV: 'development',
      PORT: '3000',
      DATABASE_URL: 'not-a-url',
      REDIS_URL: 'redis://localhost:6379'
    })
    expect(result.success).toBe(false)
  })
})