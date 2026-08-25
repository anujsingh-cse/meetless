# Meetless — Active Source of Truth for Coding Agents

Hosted reconciliation layer for AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok) via MCP.

## Quick Start

Prerequisites: Node 20+, Docker, npm

```bash
cp .env.example .env          # edit if needed
docker compose up -d          # start postgres + redis
npm ci                        # install deps
npm run db:generate           # generate Prisma client
npm run db:push               # sync schema to database
npm run dev                   # start API (http://localhost:3000)
```

Health check: GET http://localhost:3000/api/health

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start all workspaces in watch mode |
| `npm run build` | Build all workspaces |
| `npm run test` | Run all tests |
| `npm run lint` | Lint all workspaces |
| `npm run db:studio` | Open Prisma Studio |

See [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md).
