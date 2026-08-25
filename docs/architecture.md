# Architecture

## Overview
Meetless consists of a hosted control plane (Fastify API) and local MCP clients that connect via WebSocket tunnel.

## Components
- Control Plane (`apps/api`): REST + WebSocket server, rule engine, conflict detector, SoT generator
- MCP Connectors (future): per-harness adapters (Claude Code, Codex)
- Tunnel Service (future): WebSocket relay for local→cloud connectivity
- Dashboard (future): React frontend

## Data Flow
1. Local MCP client connects to `/api/ws?sessionId=...&agentId=...`
2. Agent actions streamed via WebSocket to control plane
3. Control plane persists actions, evaluates rules, detects conflicts
4. Conflicts → human approval via dashboard
5. Approved actions → injected context back to agents

## Packages
- `@meetless/shared` — config (Zod env validation) + domain types
- `@meetless/database` — Prisma schema + client (User, Team, Membership, Workspace, Session, AgentAction, Conflict)
- `@meetless/api` — Fastify control plane (health, auth placeholder, WebSocket)
