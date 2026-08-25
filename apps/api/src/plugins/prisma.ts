import { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { prisma } from '@meetless/database/client'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: typeof prisma
  }
}

export const prismaPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate('prisma', prisma)
  app.addHook('onClose', async (app) => { await app.prisma.$disconnect() })
}, { name: 'prisma' })