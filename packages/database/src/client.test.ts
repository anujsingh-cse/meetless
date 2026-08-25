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