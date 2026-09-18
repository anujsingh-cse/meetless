import { describe, it, expect } from 'vitest'
import { decide, selectPreventionRules, DEFAULT_DENY_REASON_PREFIX } from '../decision-service.js'
import type { RuleLike } from '../rule-engine.js'

const base = (over: Partial<RuleLike> = {}): RuleLike => ({
  id: 'r1', name: 'rule', enabled: true, priority: 100,
  tool: null, pathPattern: null, connectorId: null, agentPattern: null,
  action: 'NOTIFY', decision: null, message: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), ...over,
})

const pre = (over: Record<string, unknown> = {}) => ({
  agentId: 'claude-1', connectorId: 'claude-code', tool: 'edit_file',
  params: { path: 'config/prod/app.yaml' }, ...over,
})

describe('selectPreventionRules', () => {
  it('keeps only rules with decision ALLOW or DENY', () => {
    const deny = base({ id: 'd', decision: 'DENY' })
    const allow = base({ id: 'a', decision: 'ALLOW' })
    const obs = base({ id: 'o', decision: null })
    const log = base({ id: 'l', decision: 'DENY', action: 'LOG' })
    const picked = selectPreventionRules([deny, allow, obs, log])
    expect(picked.map((r) => r.id)).toEqual(['d', 'a', 'l'])
  })
})

describe('decide', () => {
  it('returns allow with no matches when no prevention rule matches', () => {
    const res = decide(pre(), [base({ decision: 'DENY', pathPattern: 'contracts/**' })])
    expect(res).toEqual({ decision: 'allow', matches: [] })
  })

  it('LOG/NOTIFY rules never deny and are not in matches', () => {
    const notify = base({ id: 'n', decision: null, pathPattern: 'config/**', action: 'NOTIFY' })
    const res = decide(pre(), [notify])
    expect(res.decision).toBe('allow')
    expect(res.matches).toHaveLength(0)
  })

  it('evaluates ALL matching prevention rules (deny + allow both present)', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 10 })
    const allow = base({ id: 'a', decision: 'ALLOW', pathPattern: 'config/**', priority: 20 })
    const res = decide(pre(), [allow, deny])
    expect(res.matches.map((m) => m.ruleId)).toEqual(['d', 'a']) // deterministic order
    expect(res.decision).toBe('deny')
  })

  it('DENY wins over ALLOW regardless of order', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 50 })
    const allow = base({ id: 'a', decision: 'ALLOW', pathPattern: 'config/**', priority: 10 })
    const res = decide(pre(), [deny, allow])
    expect(res.decision).toBe('deny')
  })

  it('selects the winning deny deterministically (highest priority deny)', () => {
    const denyHi = base({ id: 'hi', decision: 'DENY', pathPattern: 'config/**', priority: 10, message: 'high' })
    const denyLo = base({ id: 'lo', decision: 'DENY', pathPattern: 'config/**', priority: 90, message: 'low' })
    const res = decide(pre(), [denyLo, denyHi])
    expect(res.winning?.ruleId).toBe('hi')
    expect(res.reason).toBe('high')
  })

  it('uses the default deny reason when the winning deny has no message', () => {
    const deny = base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', name: 'block-prod', message: null })
    const res = decide(pre(), [deny])
    expect(res.reason).toBe(`${DEFAULT_DENY_REASON_PREFIX} block-prod`)
  })

  it('is pure: identical input yields deep-equal output (no I/O)', () => {
    const rules = [base({ id: 'd', decision: 'DENY', pathPattern: 'config/**', priority: 10 })]
    expect(decide(pre(), rules)).toEqual(decide(pre(), rules))
  })

  it('does not evaluate disabled prevention rules', () => {
    const disabled = base({ id: 'x', decision: 'DENY', pathPattern: 'config/**', enabled: false })
    const res = decide(pre(), [disabled])
    expect(res.decision).toBe('allow')
    expect(res.matches).toHaveLength(0)
  })
})