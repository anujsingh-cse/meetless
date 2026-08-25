# Meetless for Teams — Project Brief

## One-Liner
Hosted reconciliation layer for coding agents (Claude Code, Codex, Cursor, OpenCode, Grok) via MCP. Live agent stream, rule engine, conflict detection, source-of-truth generation.

## Problem
Devs running 4+ parallel agent sessions lose context. Agents hallucinate stale info. No shared memory across agents + human. 5-10 hrs/week lost to context management.

## Target Customer
Solo founders & dev teams (2-20) using AI coding agents daily.

## Buyer
Engineering lead / CTO / Solo founder — budget $50-200/mo.

## Evidence
- Meetless Show HN (49405261): benchmarks show 40% token reduction, faster completion
- Munder Difflin (49398152): 20K users/week, agents doing PR review, cold email, video production
- Proliferate (49390739): "couldn't get running on PC controlled from Mac/iPhone"
- Agent identity crisis (49389408): devs losing craft satisfaction

## Why Now
MCP standardization (2026) = universal agent interface. Multi-agent workflows becoming default. No hosted reconciliation layer exists.

## Competitors
- Proliferate: self-host only, complex setup
- Paseo: early, limited
- Continue: acquired by Cursor, archived
- Opencode Manager: basic

## Differentiation
First **hosted** multi-harness reconciliation. **Active** reconciliation (not passive RAG). Rule injection on trigger. Human approval gates for conflicts.

## MVP (6-8 weeks)
| Component | Harnesses |
|-----------|-----------|
| Control Plane API + Auth + WebSocket | — |
| MCP Connector Framework | Claude Code, Codex |
| Tunnel Service (local → cloud) | — |
| Rule Engine + Conflict Detector + SoT Generator | — |
| React Dashboard (live stream, rules, conflicts, analytics) | — |
| Team Workspaces + RBAC | — |

## Tech Stack
- **Backend:** Node.js 20+, TypeScript, Fastify, PostgreSQL (Prisma), Redis, ws
- **Frontend:** React 18, Vite, Tailwind, shadcn/ui, TanStack Query
- **MCP:** @modelcontextprotocol/sdk
- **Tunnel:** Custom WebSocket relay (Fly.io)
- **Auth:** Clerk
- **Infra:** Docker, Fly.io, Cloudflare

## Pricing
- Free: 1 concurrent agent
- Pro: $49/mo (unlimited agents, rules, history)
- Team: $199/mo (5 seats, shared rules, SSO, audit log)

## Architecture
```
┌─────────────┐     WebSocket      ┌──────────────────┐
│  Developer  │◄──────────────────►│  Control Plane   │
│  Machine    │   (via Tunnel)     │  (Hosted API)    │
│             │                    │                  │
│ ┌─────────┐ │                    │ ┌──────────────┐ │
│ │Claude   │ │                    │ │ Sessions     │ │
│ │Code     │─┤                    │ │ Rules        │ │
│ └─────────┘ │                    │ │ Conflicts    │ │
│ ┌─────────┐ │                    │ │ SoT Generator│ │
│ │Codex    │─┤                    │ └──────────────┘ │
│ └─────────┘ │                    └────────┬─────────┘
└─────────────┘                             │
                                            ▼
                                   ┌──────────────────┐
                                   │   PostgreSQL     │
                                   │   + Redis        │
                                   └──────────────────┘
```

## Key Interfaces
```typescript
interface AgentAction {
  sessionId: string
  agentId: string
  tool: string
  params: unknown
  result: unknown
  timestamp: number
}

interface Rule {
  id: string
  trigger: { type: 'file' | 'tool' | 'agent'; pattern: string }
  action: { type: 'inject' | 'approve' | 'log'; payload: unknown }
}

interface Conflict {
  id: string
  sessionId: string
  file: string
  agents: string[]
  changes: Change[]
  status: 'pending' | 'resolved' | 'ignored'
}
```

## Risks
- Harness vendors add native reconciliation
- Context windows grow 10x (less need)
- MCP standardizes memory protocol
- Single-harness lock-in

## Success Metrics (30-day validation)
- 50 signups, 10 active daily, 3+ paid conversions, NPS >30
- Context switches reduced >50%
- Errors caught >3/week per user