import { describe, it, expect } from 'vitest'
import { evaluate, isValidGlob } from '../rule-engine.js'
import type { RuleLike } from '../rule-engine.js'

const base = (over: Partial<RuleLike> = {}): RuleLike => ({
  id: 'r1',
  name: 'rule',
  enabled: true,
  priority: 100,
  tool: null,
  pathPattern: null,
  connectorId: null,
  agentPattern: null,
  action: 'LOG',
  message: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
})

const event = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  agentId: 'claude-1',
  tool: 'edit_file',
  params: { path: 'src/app.ts', content: 'x' },
  result: {},
  timestamp: 1,
  connectorId: 'claude-code',
  connectorVersion: '1.0.0',
  mcpEventId: 'm1',
  ...over,
})

describe('evaluate', () => {
  it('matches a rule on exact tool', () => {
    const r = base({ tool: 'edit_file', action: 'LOG' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].ruleId).toBe('r1')
    expect(res[0].action).toBe('LOG')
  })

  it('does not match a rule when tool differs', () => {
    const r = base({ tool: 'bash' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches a path glob **', () => {
    const r = base({ pathPattern: 'config/prod/**', action: 'NOTIFY' })
    const res = evaluate(event({ params: { path: 'config/prod/app.yaml', content: 'x' } }) as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].matchedOn.pathPattern).toBe('config/prod/**')
  })

  it('matches a path glob * within a segment', () => {
    const r = base({ pathPattern: 'src/*.ts' })
    const res = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(res).toHaveLength(1)
  })

  it('does not match when path does not fit the pattern', () => {
    const r = base({ pathPattern: 'contracts/**' })
    const res = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(res).toHaveLength(0)
  })

  it('normalizes backslashes before matching', () => {
    const r = base({ pathPattern: 'src/*.ts' })
    const res = evaluate(event({ params: { path: 'src\\app.ts' } }) as never, [r])
    expect(res).toHaveLength(1)
  })

  it('never matches a path rule when the event has no string path', () => {
    const r = base({ pathPattern: '**' })
    const res = evaluate(event({ tool: 'bash', params: { command: 'ls' } }) as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches a rule on exact connectorId', () => {
    const r = base({ connectorId: 'claude-code' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].matchedOn.connectorId).toBe('claude-code')
  })

  it('does not match when connectorId differs', () => {
    const r = base({ connectorId: 'codex-cli' })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('matches an agent pattern glob', () => {
    const r = base({ agentPattern: 'frontend-*' })
    const res = evaluate(event({ agentId: 'frontend-editor-1' }) as never, [r])
    expect(res).toHaveLength(1)
    expect(res[0].event.agentId).toBe('frontend-editor-1')
  })

  it('respects AND semantics: all set constraints must match', () => {
    const r = base({ connectorId: 'claude-code', tool: 'edit_file', pathPattern: 'contracts/**' })
    const good = evaluate(event({ params: { path: 'contracts/api.yaml' } }) as never, [r])
    const bad = evaluate(event({ params: { path: 'src/app.ts' } }) as never, [r])
    expect(good).toHaveLength(1)
    expect(bad).toHaveLength(0)
  })

  it('does not evaluate disabled rules', () => {
    const r = base({ enabled: false })
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(0)
  })

  it('treats a zero-constraint rule as matching everything (pure-evaluator contract)', () => {
    const r = base({}) // all constraints null
    const res = evaluate(event() as never, [r])
    expect(res).toHaveLength(1)
  })

  it('fires ALL matching rules; priority only orders results and never suppresses', () => {
    const low = base({ id: 'low', priority: 500 })
    const high = base({ id: 'high', priority: 10 })
    const res = evaluate(event() as never, [high, low]) // priority 10 first
    expect(res.map((x) => x.ruleId)).toEqual(['high', 'low'])
  })

  it('orders by priority asc, then createdAt asc, then id asc (input order irrelevant)', () => {
    const a = base({ id: 'a', priority: 100, createdAt: new Date('2026-01-02T00:00:00Z') })
    const b = base({ id: 'b', priority: 100, createdAt: new Date('2026-01-01T00:00:00Z') })
    const c = base({ id: 'c', priority: 50 })
    const res = evaluate(event() as never, [a, b, c])
    expect(res.map((x) => x.ruleId)).toEqual(['c', 'b', 'a'])
  })

  it('is deterministic: same input twice yields deep-equal output', () => {
    const rules = [base({ id: 'a' }), base({ id: 'b', action: 'NOTIFY', pathPattern: 'x/**' })]
    const e = event() as never
    expect(evaluate(e, rules)).toEqual(evaluate(e, rules))
  })

  it('produces the fixed nullable matchedOn shape', () => {
    const r = base({ pathPattern: 'config/**' })
    const res = evaluate(event({ params: { path: 'config/prod/app.yaml' } }) as never, [r])
    expect(res[0].matchedOn).toEqual({ tool: null, pathPattern: 'config/**', connectorId: null, agentPattern: null })
  })

  it('connector-independence: connectorless rule yields identical results across all connectors', () => {
    const r = base({ pathPattern: 'src/**' })
    const connectors = ['claude-code', 'codex-cli', 'cursor-hooks', 'opencode']
    const results = connectors.map((cid) => {
      const res = evaluate(event({ connectorId: cid }) as never, [r])
      return { tool: res[0].event.tool, path: res[0].event.path }
    })
    expect(results).toEqual([
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
      { tool: 'edit_file', path: 'src/app.ts' },
    ])
  })
})

describe('isValidGlob', () => {
  it('accepts a valid glob', () => {
    expect(isValidGlob('config/prod/**')).toBe(true)
    expect(isValidGlob('*.ts')).toBe(true)
  })
  it('rejects a malformed glob (unbalanced paren)', () => {
    expect(isValidGlob('config(prod/**')).toBe(false)
  })
})
