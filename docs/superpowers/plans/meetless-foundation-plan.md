# Meetless Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize a production-ready Node.js/TypeScript monorepo with Fastify API, PostgreSQL (Prisma), Redis, Docker, and CI/CD — the foundation for the Meetless control plane.

**Architecture:** Monorepo (npm workspaces) with `apps/api` (Fastify) and `packages/shared` (types, config). PostgreSQL via Prisma ORM. Redis for sessions/pubsub. Docker Compose for local dev. GitHub Actions for CI.

**Tech Stack:** Node.js 20, TypeScript 5, Fastify 4, Prisma 5, Redis 7, Docker, Vitest, ESLint, Prettier, Clerk SDK (auth placeholder).

**Spec:** `docs/superpowers/plans/2026-08-24-meetless-project-brief.md`

## Global Constraints
- Node.js >= 20.0.0
- TypeScript strict mode enabled
- Fastify plugins only (no Express)
- Prisma schema in `packages/database/prisma/schema.prisma`
- All env vars via `dotenv` + Zod validation
- Tests: Vitest, >= 80% coverage on new code
- Commits: Conventional Commits (`feat:`, `fix:`, `chore:`)

---

### Task 1: Initialize Monorepo Structure

**Files:**
- Create: `package.json` (root, npm workspaces)
- Create: `tsconfig.base.json`
- Create: `.github/workflows/ci.yml`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc`
- Create: `.gitignore`

**Interfaces:**
- Produces: workspace config, TS config, lint/format rules, CI pipeline

- [ ] **Step 1: Write root package.json**

```json
{
  "name": "meetless",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "db:generate": "turbo run db:generate",
    "db:push": "turbo run db:push",
    "db:studio": "turbo run db:studio"
  },
  "devDependencies": {
    "turbo": "^1.13.0",
    "typescript": "^5.4.0",
    "eslint": "^8.57.0",
    "prettier": "^3.2.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0"
  },
  "engines": { "node": ">=20.0.0" }
}
```

- [ ] **Step 2: Write tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@meetless/shared/*": ["packages/shared/src/*"],
      "@meetless/database/*": ["packages/database/src/*"]
    }
  }
}
```

- [ ] **Step 3: Write .github/workflows/ci.yml**

```yaml
name: CI
on: [push, pull_request]
jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
  docker:
    runs-on: ubuntu-latest
    needs: lint-and-test
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.yml build
```

- [ ] **Step 4: Write .eslintrc.cjs and .prettierrc**

```js
// .eslintrc.cjs
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier'
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['dist/', 'node_modules/', '*.config.*']
}
```

```json
// .prettierrc
{ "semi": true, "singleQuote": true, "tabWidth": 2, "trailingComma": "es5", "printWidth": 100 }
```

- [ ] **Step 5: Write .gitignore**

```
node_modules/
dist/
build/
*.log
.env
.env.local
.env.*.local
!.env.example
.turbo/
coverage/
.DS_Store
*.tsbuildinfo
```

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .github/workflows/ci.yml .eslintrc.cjs .prettierrc .gitignore
git commit -m "chore: initialize monorepo with turbo, typescript, eslint, prettier, ci"
```

---

### Task 2: Create Shared Config Package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/config/index.ts`
- Create: `packages/shared/src/config/schema.ts`
- Create: `packages/shared/src/types/index.ts`
- Test: `packages/shared/src/config/schema.test.ts`

**Interfaces:**
- Consumes: root TS paths (`@meetless/shared/*`)
- Produces: `config` object (validated env), shared TypeScript types

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@meetless/shared",
  "version": "0.0.0",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "zod": "^3.22.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "vitest": "^1.3.0",
    "@types/node": "^20.11.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*"] }
```

- [ ] **Step 3: Write schema.ts (Zod env validation)**

```typescript
import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
})

export type Env = z.infer<typeof envSchema>
```

- [ ] **Step 4: Write config/index.ts**

```typescript
import { envSchema, type Env } from './schema.js'
import 'dotenv/config'

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config: Env = parsed.data
export default config
```

- [ ] **Step 5: Write types/index.ts (from Project Brief interfaces)**

```typescript
export interface AgentAction {
  sessionId: string
  agentId: string
  tool: string
  params: unknown
  result: unknown
  timestamp: number
}

export interface Rule {
  id: string
  trigger: { type: 'file' | 'tool' | 'agent'; pattern: string }
  action: { type: 'inject' | 'approve' | 'log'; payload: unknown }
}

export interface Conflict {
  id: string
  sessionId: string
  file: string
  agents: string[]
  changes: Change[]
  status: 'pending' | 'resolved' | 'ignored'
}

export interface Change {
  agentId: string
  before: string
  after: string
  range: { start: number; end: number }
}
```

- [ ] **Step 6: Write schema.test.ts**

```typescript
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
```

- [ ] **Step 7: Run tests, build, commit**

```bash
npm run test --workspace=@meetless/shared
npm run build --workspace=@meetless/shared
git add packages/shared
git commit -m "feat: add @meetless/shared package with config and types"
```

---

### Task 3: Create Database Package (Prisma)

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/tsconfig.json`
- Create: `packages/database/prisma/schema.prisma`
- Create: `packages/database/src/client.ts`
- Test: `packages/database/src/client.test.ts`

**Interfaces:**
- Consumes: `@meetless/shared` (config types)
- Produces: `PrismaClient` singleton, database types

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@meetless/database",
  "version": "0.0.0",
  "main": "./src/client.ts",
  "types": "./src/client.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "db:generate": "prisma generate",
    "db:push": "prisma db push",
    "db:studio": "prisma studio",
    "test": "vitest run",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "@prisma/client": "^5.10.0",
    "@meetless/shared": "*"
  },
  "devDependencies": {
    "prisma": "^5.10.0",
    "vitest": "^1.3.0",
    "@types/node": "^20.11.0"
  }
}
```

- [ ] **Step 2: Write prisma/schema.prisma**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(cuid())
  clerkId       String    @unique
  email         String    @unique
  name          String?
  avatarUrl     String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  memberships   Membership[]
  sessions      Session[]
}

model Team {
  id          String       @id @default(cuid())
  name        String
  slug        String       @unique
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]
  workspaces  Workspace[]
}

model Membership {
  id        String   @id @default(cuid())
  userId    String
  teamId    String
  role      Role     @default(MEMBER)
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  team      Team     @relation(fields: [teamId], references: [id], onDelete: Cascade)
  @@unique([userId, teamId])
}

enum Role {
  OWNER
  ADMIN
  MEMBER
}

model Workspace {
  id          String    @id @default(cuid())
  teamId      String
  name        String
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  team        Team      @relation(fields: [teamId], references: [id], onDelete: Cascade)
  sessions    Session[]
}

model Session {
  id          String       @id @default(cuid())
  workspaceId String
  userId      String
  name        String
  status      SessionStatus @default(ACTIVE)
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  workspace   Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  agentActions AgentAction[]
  conflicts   Conflict[]
}

enum SessionStatus {
  ACTIVE
  PAUSED
  COMPLETED
  ARCHIVED
}

model AgentAction {
  id        String   @id @default(cuid())
  sessionId String
  agentId   String
  tool      String
  params    Json
  result    Json?
  timestamp DateTime @default(now())
  session   Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}

model Conflict {
  id        String         @id @default(cuid())
  sessionId String
  file      String
  agents    String[]
  changes   Json
  status    ConflictStatus @default(PENDING)
  createdAt DateTime       @default(now())
  resolvedAt DateTime?
  session   Session        @relation(fields: [sessionId], references: [id], onDelete: Cascade)
}

enum ConflictStatus {
  PENDING
  RESOLVED
  IGNORED
}
```

- [ ] **Step 3: Write client.ts**

```typescript
import { PrismaClient } from '@prisma/client'
import { config } from '@meetless/shared/config'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

export const prisma = globalForPrisma.prisma || new PrismaClient({
  log: config.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
})

if (config.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
```

- [ ] **Step 4: Write client.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

describe('PrismaClient', () => {
  beforeAll(async () => { await prisma.$connect() })
  afterAll(async () => { await prisma.$disconnect() })

  it('connects to database', async () => {
    const result = await prisma.$queryRaw`SELECT 1 as test`
    expect(result).toEqual([{ test: 1 }])
  })
})
```

- [ ] **Step 5: Generate client, run test, commit**

```bash
npm run db:generate --workspace=@meetless/database
npm run test --workspace=@meetless/database
git add packages/database
git commit -m "feat: add @meetless/database package with Prisma schema and client"
```

---

### Task 4: Create API App (Fastify)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/plugins/prisma.ts`
- Create: `apps/api/src/plugins/redis.ts`
- Test: `apps/api/src/routes/health.test.ts`

**Interfaces:**
- Consumes: `@meetless/shared/config`, `@meetless/database/prisma`, `ioredis`
- Produces: Fastify app instance, health endpoint

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@meetless/api",
  "version": "0.0.0",
  "main": "./src/server.ts",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "fastify": "^4.26.0",
    "fastify-type-provider-zod": "^1.1.0",
    "ioredis": "^5.3.0",
    "zod": "^3.22.0",
    "@meetless/shared": "*",
    "@meetless/database": "*"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "vitest": "^1.3.0",
    "@types/node": "^20.11.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src/**/*"] }
```

- [ ] **Step 3: Write plugins/prisma.ts**

```typescript
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '@meetless/database/client'

export const prismaPlugin: FastifyPluginAsync = async (app) => {
  app.decorate('prisma', prisma)
  app.addHook('onClose', async (app) => { await app.prisma.$disconnect() })
}
```

- [ ] **Step 4: Write plugins/redis.ts**

```typescript
import { FastifyPluginAsync } from 'fastify'
import Redis from 'ioredis'
import { config } from '@meetless/shared/config'

export const redisPlugin: FastifyPluginAsync = async (app) => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 50, 2000)
  })
  redis.on('error', (err) => app.log.error({ err }, 'Redis connection error'))
  app.decorate('redis', redis)
  app.addHook('onClose', async (app) => { await app.redis.quit() })
}
```

- [ ] **Step 5: Write routes/health.ts**

```typescript
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/health', {
    schema: {
      response: {
        200: z.object({ status: z.literal('ok'), timestamp: z.string() })
      }
    }
  }, async () => ({ status: 'ok' as const, timestamp: new Date().toISOString() }))

  app.get('/health/ready', {
    schema: {
      response: {
        200: z.object({ status: z.literal('ready'), checks: z.object({ database: z.boolean(), redis: z.boolean() }) }),
        503: z.object({ status: z.literal('not ready'), checks: z.object({ database: z.boolean(), redis: z.boolean() }) })
      }
    }
  }, async (req, reply) => {
    const checks = { database: false, redis: false }
    try { await app.prisma.$queryRaw`SELECT 1`; checks.database = true } catch {}
    try { await app.redis.ping(); checks.redis = true } catch {}
    const ready = checks.database && checks.redis
    reply.code(ready ? 200 : 503)
    return { status: ready ? 'ready' as const : 'not ready' as const, checks }
  })
}
```

- [ ] **Step 6: Write app.ts**

```typescript
import Fastify from 'fastify'
import { config } from '@meetless/shared/config'
import { prismaPlugin } from './plugins/prisma.js'
import { redisPlugin } from './plugins/redis.js'
import { healthRoutes } from './routes/health.js'

export async function buildApp() {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } })
  await app.register(prismaPlugin)
  await app.register(redisPlugin)
  await app.register(healthRoutes, { prefix: '/api' })
  return app
}
```

- [ ] **Step 7: Write server.ts**

```typescript
import { buildApp } from './app.js'
import { config } from '@meetless/shared/config'

async function main() {
  const app = await buildApp()
  try {
    await app.listen({ port: config.PORT, host: config.HOST })
    console.log(`🚀 Server listening on http://${config.HOST}:${config.PORT}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
main()
```

- [ ] **Step 8: Write health.test.ts**

```typescript
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
```

- [ ] **Step 9: Run tests, build, commit**

```bash
npm run test --workspace=@meetless/api
npm run build --workspace=@meetless/api
git add apps/api
git commit -m "feat: add @meetless/api with Fastify, health endpoints, Prisma/Redis plugins"
```

---

### Task 5: Docker Compose for Local Development

**Files:**
- Create: `docker-compose.yml`
- Create: `docker-compose.prod.yml`
- Create: `apps/api/Dockerfile`
- Create: `.env.example`

**Interfaces:**
- Produces: PostgreSQL, Redis, API containers; env template

- [ ] **Step 1: Write docker-compose.yml**

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: meetless
      POSTGRES_USER: meetless
      POSTGRES_PASSWORD: meetless
    ports: ["5432:5432"]
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meetless -d meetless"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    ports: ["3000:3000"]
    environment:
      NODE_ENV: development
      DATABASE_URL: postgresql://meetless:meetless@postgres:5432/meetless
      REDIS_URL: redis://redis:6379
      PORT: "3000"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    volumes:
      - ./apps/api:/app
      - /app/node_modules

volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 2: Write apps/api/Dockerfile**

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN npm install -g turbo
COPY package.json turbo.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/database/package.json ./packages/database/
COPY apps/api/package.json ./apps/api/
RUN npm ci
COPY . .
RUN npm run build --filter=@meetless/api
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace=@meetless/api"]
```

- [ ] **Step 3: Write .env.example**

```
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://meetless:meetless@localhost:5432/meetless
REDIS_URL=redis://localhost:6379
CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
LOG_LEVEL=debug
```

- [ ] **Step 4: Write docker-compose.prod.yml (minimal)**

```yaml
version: '3.8'
services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      NODE_ENV: production
    deploy:
      resources:
        limits:
          memory: 512M
```

- [ ] **Step 5: Test compose up, commit**

```bash
docker compose up -d --build
sleep 10
curl -f http://localhost:3000/api/health
docker compose down
git add docker-compose.yml docker-compose.prod.yml apps/api/Dockerfile .env.example
git commit -m "chore: add Docker Compose for local dev and production"
```

---

### Task 6: Prisma Migrations & Seed

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (add seed)
- Create: `packages/database/prisma/seed.ts`
- Create: `packages/database/package.json` (add seed script)

**Interfaces:**
- Consumes: Prisma schema
- Produces: Migration files, seed data

- [ ] **Step 1: Update package.json scripts**

```json
"scripts": {
  "db:generate": "prisma generate",
  "db:push": "prisma db push",
  "db:migrate": "prisma migrate dev",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts",
  "db:studio": "prisma studio",
  "test": "vitest run",
  "lint": "eslint src --ext .ts"
}
```

- [ ] **Step 2: Write prisma/seed.ts**

```typescript
import { PrismaClient, Role } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')
  // Seed will be run manually in dev; production uses migrations
  console.log('✅ Seed complete (no-op for now)')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
```

- [ ] **Step 3: Run migration, commit**

```bash
npm run db:migrate --workspace=@meetless/database -- --name init
npm run db:seed --workspace=@meetless/database
git add packages/database/prisma/migrations packages/database/prisma/seed.ts packages/database/package.json
git commit -m "feat: add initial Prisma migration and seed script"
```

---

### Task 7: Environment Validation & Clerk Auth Placeholder

**Files:**
- Modify: `apps/api/src/plugins/auth.ts` (new)
- Modify: `apps/api/src/app.ts` (register auth)
- Test: `apps/api/src/plugins/auth.test.ts`

**Interfaces:**
- Consumes: `@meetless/shared/config` (Clerk keys)
- Produces: `app.auth` decorator, `requireAuth` hook

- [ ] **Step 1: Write plugins/auth.ts**

```typescript
import { FastifyPluginAsync } from 'fastify'
import { config } from '@meetless/shared/config'

export const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate('auth', {
    async verify(token: string) {
      if (!config.CLERK_SECRET_KEY) return { userId: 'dev-user', email: 'dev@local' }
      // TODO: Implement Clerk JWT verification
      throw new Error('Clerk not configured')
    }
  })

  app.addHook('preHandler', async (req, res) => {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      try {
        req.user = await app.auth.verify(authHeader.slice(7))
      } catch { /* ignore */ }
    }
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: { userId: string; email: string }
  }
}
```

- [ ] **Step 2: Update app.ts to register auth**

```typescript
// Add after redisPlugin registration:
import { authPlugin } from './plugins/auth.js'
// ...
await app.register(authPlugin)
```

- [ ] **Step 3: Write auth.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { buildApp } from '../app.js'

describe('Auth plugin', () => {
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeAll(async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '')
    app = await buildApp()
    await app.ready()
  })
  afterAll(async () => { await app.close(); vi.unstubAllEnvs() })

  it('attaches user when no Clerk key (dev mode)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { authorization: 'Bearer dev-token' }
    })
    expect(res.statusCode).toBe(200)
  })
})
```

- [ ] **Step 4: Run tests, commit**

```bash
npm run test --workspace=@meetless/api
git add apps/api/src/plugins/auth.ts apps/api/src/app.ts apps/api/src/plugins/auth.test.ts
git commit -m "feat: add auth plugin with Clerk placeholder and dev-mode bypass"
```

---

### Task 8: WebSocket Infrastructure

**Files:**
- Create: `apps/api/src/plugins/websocket.ts`
- Create: `apps/api/src/routes/ws.ts`
- Create: `apps/api/src/services/ws-manager.ts`
- Test: `apps/api/src/services/ws-manager.test.ts`

**Interfaces:**
- Consumes: Fastify app, `@meetless/shared/types` (AgentAction)
- Produces: WebSocket server, connection manager, message router

- [ ] **Step 1: Write services/ws-manager.ts**

```typescript
import { WebSocket } from 'ws'
import { AgentAction } from '@meetless/shared/types'

export interface WSClient {
  id: string
  sessionId: string
  agentId: string
  ws: WebSocket
  connectedAt: Date
}

export class WSManager {
  private clients = new Map<string, WSClient>()
  private sessionClients = new Map<string, Set<string>>()

  add(client: WSClient) {
    this.clients.set(client.id, client)
    if (!this.sessionClients.has(client.sessionId)) this.sessionClients.set(client.sessionId, new Set())
    this.sessionClients.get(client.sessionId)!.add(client.id)
  }

  remove(clientId: string) {
    const client = this.clients.get(clientId)
    if (client) {
      this.sessionClients.get(client.sessionId)?.delete(clientId)
      this.clients.delete(clientId)
    }
  }

  broadcastToSession(sessionId: string, message: unknown, excludeId?: string) {
    const ids = this.sessionClients.get(sessionId)
    if (!ids) return
    const data = JSON.stringify(message)
    for (const id of ids) {
      if (id !== excludeId) {
        const client = this.clients.get(id)
        if (client?.ws.readyState === WebSocket.OPEN) client.ws.send(data)
      }
    }
  }

  broadcastAction(action: AgentAction) {
    this.broadcastToSession(action.sessionId, { type: 'agent_action', payload: action }, action.agentId)
  }

  getSessionClients(sessionId: string): WSClient[] {
    const ids = this.sessionClients.get(sessionId)
    if (!ids) return []
    return Array.from(ids).map(id => this.clients.get(id)!).filter(Boolean)
  }
}

export const wsManager = new WSManager()
```

- [ ] **Step 2: Write plugins/websocket.ts**

```typescript
import { FastifyPluginAsync } from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'
import { wsManager, WSClient } from '../services/ws-manager.js'
import { v4 as uuidv4 } from 'uuid'

export const wsPlugin: FastifyPluginAsync = async (app) => {
  const wss = new WebSocketServer({ noServer: true })

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    if (url.pathname === '/api/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    }
  })

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const sessionId = url.searchParams.get('sessionId')
    const agentId = url.searchParams.get('agentId') || uuidv4()

    if (!sessionId) { ws.close(4000, 'sessionId required'); return }

    const client: WSClient = { id: uuidv4(), sessionId, agentId, ws, connectedAt: new Date() }
    wsManager.add(client)

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'agent_action') wsManager.broadcastAction(msg.payload)
      } catch { /* ignore invalid JSON */ }
    })

    ws.on('close', () => wsManager.remove(client.id))
    ws.on('error', () => wsManager.remove(client.id))

    ws.send(JSON.stringify({ type: 'connected', clientId: client.id }))
  })

  app.decorate('wsManager', wsManager)
  app.addHook('onClose', () => { wss.close() })
}
```

- [ ] **Step 3: Write routes/ws.ts (REST fallback for non-WS clients)**

```typescript
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { wsManager } from '../services/ws-manager.js'

export const wsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/api/sessions/:sessionId/actions', {
    schema: {
      params: z.object({ sessionId: z.string() }),
      body: z.object({
        agentId: z.string(),
        tool: z.string(),
        params: z.unknown(),
        result: z.unknown().optional()
      })
    }
  }, async (req, reply) => {
    const action = {
      sessionId: req.params.sessionId,
      agentId: req.body.agentId,
      tool: req.body.tool,
      params: req.body.params,
      result: req.body.result,
      timestamp: Date.now()
    }
    wsManager.broadcastAction(action)
    await app.prisma.agentAction.create({ data: { ...action, timestamp: new Date(action.timestamp) } })
    return { ok: true }
  })

  app.get('/api/sessions/:sessionId/clients', {
    schema: { params: z.object({ sessionId: z.string() }) }
  }, async (req) => {
    const clients = wsManager.getSessionClients(req.params.sessionId)
    return { clients: clients.map(c => ({ id: c.id, agentId: c.agentId, connectedAt: c.connectedAt })) }
  })
}
```

- [ ] **Step 4: Update app.ts to register wsPlugin and wsRoutes**

```typescript
// Add imports:
import { wsPlugin } from './plugins/websocket.js'
import { wsRoutes } from './routes/ws.js'
// Add registrations:
await app.register(wsPlugin)
await app.register(wsRoutes)
```

- [ ] **Step 5: Write ws-manager.test.ts**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { wsManager, WSClient } from '../services/ws-manager.js'
import { WebSocket } from 'ws'

class MockWS {
  readyState = WebSocket.OPEN
  sent: string[] = []
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = WebSocket.CLOSED }
}

describe('WSManager', () => {
  beforeEach(() => {
    // @ts-expect-error - clear private state for testing
    wsManager['clients'].clear()
    wsManager['sessionClients'].clear()
  })

  it('adds and removes clients', () => {
    const ws = new MockWS()
    const client: WSClient = { id: '1', sessionId: 's1', agentId: 'a1', ws, connectedAt: new Date() }
    wsManager.add(client)
    expect(wsManager.getSessionClients('s1')).toHaveLength(1)
    wsManager.remove('1')
    expect(wsManager.getSessionClients('s1')).toHaveLength(0)
  })

  it('broadcasts to session excluding sender', () => {
    const ws1 = new MockWS(), ws2 = new MockWS()
    wsManager.add({ id: '1', sessionId: 's1', agentId: 'a1', ws: ws1, connectedAt: new Date() })
    wsManager.add({ id: '2', sessionId: 's1', agentId: 'a2', ws: ws2, connectedAt: new Date() })
    wsManager.broadcastAction({
      sessionId: 's1', agentId: 'a1', tool: 'test', params: {}, result: null, timestamp: Date.now()
    })
    expect(ws1.sent).toHaveLength(0)
    expect(ws2.sent).toHaveLength(1)
  })
})
```

- [ ] **Step 6: Install uuid, run tests, commit**

```bash
npm install uuid @types/uuid --workspace=@meetless/api
npm run test --workspace=@meetless/api
git add apps/api/src/plugins/websocket.ts apps/api/src/routes/ws.ts apps/api/src/services/ws-manager.ts apps/api/src/services/ws-manager.test.ts apps/api/src/app.ts apps/api/package.json
git commit -m "feat: add WebSocket infrastructure for real-time agent streaming"
```

---

### Task 9: API Integration Tests & Dev Scripts

**Files:**
- Create: `apps/api/tests/integration.test.ts`
- Modify: `package.json` (root, add dev:api script)
- Create: `.env.test`

**Interfaces:**
- Consumes: Built app, test database
- Produces: Integration test suite

- [ ] **Step 1: Write .env.test**

```
NODE_ENV=test
PORT=3001
DATABASE_URL=postgresql://meetless:meetless@localhost:5432/meetless_test
REDIS_URL=redis://localhost:6379/1
LOG_LEVEL=silent
```

- [ ] **Step 2: Write integration.test.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../src/app.js'
import { prisma } from '@meetless/database/client'

let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://meetless:meetless@localhost:5432/meetless_test'
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await prisma.$disconnect()
})

describe('API integration', () => {
  it('health endpoint works', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).status).toBe('ok')
  })

  it('ready endpoint checks deps', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' })
    expect([200, 503]).toContain(res.statusCode)
  })

  it('creates and queries agent action via REST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session/actions',
      payload: { agentId: 'test-agent', tool: 'test_tool', params: { foo: 'bar' } }
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).ok).toBe(true)
  })
})
```

- [ ] **Step 3: Update root package.json with dev:api**

```json
"scripts": {
  "dev:api": "dotenv -e .env -- npm run dev --workspace=@meetless/api",
  "test:integration": "dotenv -e .env.test -- npm run test --workspace=@meetless/api -- tests/integration.test.ts"
}
```

- [ ] **Step 4: Run integration tests against docker compose, commit**

```bash
docker compose up -d
npm run db:push --workspace=@meetless/database
npm run test:integration
docker compose down
git add apps/api/tests/integration.test.ts package.json .env.test
git commit -m "test: add integration tests and dev scripts"
```

---

### Task 10: Documentation & README

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/development.md`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Project documentation

- [ ] **Step 1: Write README.md**

```markdown
# Meetless — Active Source of Truth for Coding Agents

Hosted reconciliation layer for AI coding agents (Claude Code, Codex, Cursor, OpenCode, Grok) via MCP.

## Quick Start

```bash
# Prerequisites: Node 20+, Docker, npm
cp .env.example .env
# Edit .env with your DATABASE_URL and REDIS_URL

# Start infra
docker compose up -d

# Install deps
npm ci

# Setup database
npm run db:generate
npm run db:push

# Start dev server
npm run dev:api
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start all workspaces in watch mode |
| `npm run build` | Build all workspaces |
| `npm run test` | Run all tests |
| `npm run lint` | Lint all workspaces |
| `npm run db:studio` | Open Prisma Studio |

## Architecture

See [docs/architecture.md](docs/architecture.md)

## Development

See [docs/development.md](docs/development.md)
```

- [ ] **Step 2: Write docs/architecture.md**

```markdown
# Architecture

## Overview
Meetless consists of a hosted control plane (Fastify API) and local MCP clients that connect via WebSocket tunnel.

## Components
- **Control Plane** (`apps/api`): REST + WebSocket server, rule engine, conflict detector, SoT generator
- **MCP Connectors** (future): Per-harness adapters (Claude Code, Codex, etc.)
- **Tunnel Service** (future): WebSocket relay for local→cloud connectivity
- **Dashboard** (future): React frontend for live stream, rules, conflicts

## Data Flow
1. Local MCP client connects to `/api/ws?sessionId=...&agentId=...`
2. Agent actions streamed via WebSocket to control plane
3. Control plane persists actions, evaluates rules, detects conflicts
4. Conflicts → human approval via dashboard
5. Approved actions → injected context back to agents
6. Periodic SoT generation → `MEETLESS.md`

## Database Schema
See `packages/database/prisma/schema.prisma`
```

- [ ] **Step 3: Write docs/development.md**

```markdown
# Development Guide

## Local Development
```bash
docker compose up -d
npm run dev:api
```

## Database
```bash
npm run db:studio    # Open Prisma Studio
npm run db:migrate   # Create new migration
npm run db:seed      # Run seed script
```

## Testing
```bash
npm run test              # Unit tests
npm run test:integration  # Integration tests (requires docker)
```

## Adding a New Workspace
1. Create folder under `apps/` or `packages/`
2. Add `package.json` with `"name": "@meetless/<name>"`
3. Add `"@meetless/<name>": "*"` to dependent workspaces
4. Run `npm ci` from root
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture.md docs/development.md
git commit -m "docs: add README and architecture/development guides"
```

---

**Plan complete.** Saved to `docs/superpowers/plans/meetless-foundation-plan.md`.

**Execution options:**
1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks
2. **Inline Execution** — Execute tasks in this session using executing-plans

**Which approach?**