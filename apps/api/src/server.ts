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