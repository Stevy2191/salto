import path from 'node:path'
import express from 'express'

const app = express()

// One reverse-proxy hop (e.g. Nginx Proxy Manager) so X-Forwarded-* headers
// are trusted for secure cookies and rate limiting.
app.set('trust proxy', 1)

const port = Number(process.env.PORT ?? 3000)
const distDir = path.resolve(import.meta.dirname, '../dist')

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use(express.static(distDir))

// SPA fallback: unknown non-API paths get the frontend, which handles routing.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.sendFile(path.join(distDir, 'index.html'))
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Salto listening on http://0.0.0.0:${port}`)
})
