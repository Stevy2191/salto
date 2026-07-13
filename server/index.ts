import path from 'node:path'
import { createApp } from './app.ts'
import { openDb } from './db.ts'

const dataDir = process.env.DATA_DIR ?? './data'
const db = openDb(path.join(dataDir, 'salto.db'))
const app = createApp(db)

const port = Number(process.env.PORT ?? 3000)
app.listen(port, '0.0.0.0', () => {
  console.log(`Salto listening on http://0.0.0.0:${port}`)
})
