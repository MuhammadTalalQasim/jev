const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local')
  const out = {}
  if (!fs.existsSync(envPath)) return out
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) out[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

async function main() {
  const env = loadEnv()
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL in .env.local')
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: (process.env.DATABASE_SSL || env.DATABASE_SSL) === 'true'
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 20000,
  })

  const email = process.env.TEJARIFY_USER_EMAIL || env.TEJARIFY_USER_EMAIL || 'tejarify@peham.ltd'
  const u = await pool.query(
    'SELECT id, email FROM "User" WHERE lower(email) = lower($1) LIMIT 1',
    [email]
  )
  console.log('user', u.rows[0] || null)

  const top = await pool.query(`
    SELECT u.email,
           COUNT(t.id)::int AS txs,
           COALESCE(SUM(t."totalAmount"), 0)::float AS total,
           MAX(t."createdAt") AS last
    FROM "User" u
    INNER JOIN "POSTransaction" t ON t."userId" = u.id
    WHERE t.status = 'COMPLETED'
    GROUP BY u.email
    ORDER BY last DESC NULLS LAST
    LIMIT 10
  `)
  console.log('merchants_with_pos', top.rows)

  if (u.rows[0]) {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const s = await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS total
       FROM "POSTransaction"
       WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false AND "createdAt" >= $2`,
      [u.rows[0].id, start]
    )
    console.log('todayPos_for_email', s.rows[0])
  }

  await pool.end()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
