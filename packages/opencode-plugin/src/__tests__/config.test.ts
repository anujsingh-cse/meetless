import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config.js'

describe('loadConfig', () => {
  it('reads API base url and token from env', () => {
    const cfg = loadConfig({ MEETLESS_API_BASE_URL: 'https://meetless.example.com', MEETLESS_API_TOKEN: 'sekret' })
    expect(cfg.apiBaseUrl).toBe('https://meetless.example.com')
    expect(cfg.apiToken).toBe('sekret')
  })

  it('allows token and agent id to be absent', () => {
    const cfg = loadConfig({ MEETLESS_API_BASE_URL: 'http://127.0.0.1:3000' })
    expect(cfg.apiToken).toBeUndefined()
    expect(cfg.agentId).toBeUndefined()
  })

  it('defaults base url to http://127.0.0.1:4096 when not provided', () => {
    expect(loadConfig({}).apiBaseUrl).toBe('http://127.0.0.1:4096')
  })
})
