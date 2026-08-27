import http from 'http'

const args = process.argv.slice(2)
function getArg(name: string) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? args[idx + 1] : undefined
}

const secret = getArg('secret')
const port = getArg('port')

let body = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => { body += chunk })
process.stdin.on('end', () => {
  if (!secret || !port) {
    process.exit(1)
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port: Number(port),
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-meetless-secret': secret,
    },
  })

  req.on('response', (res) => {
    process.exit(res.statusCode === 200 ? 0 : 1)
  })

  req.on('error', () => {
    process.exit(1)
  })

  req.end(body)
})
