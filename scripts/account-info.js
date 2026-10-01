const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local')
  const out = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) out[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
  }
  return out
}

async function main() {
  const env = loadEnv()
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  })

  const configuredEmail = env.TEJARIFY_USER_EMAIL || null
  const configuredId = env.TEJARIFY_USER_ID || null

  const [{ count: totalUsers }] = (
    await pool.query('SELECT COUNT(*)::int AS count FROM "User"')
  ).rows
  const [{ count: usersWithPos }] = (
    await pool.query(`
      SELECT COUNT(DISTINCT "userId")::int AS count
      FROM "POSTransaction"
      WHERE status = 'COMPLETED'
    `)
  ).rows

  const active = configuredId
    ? (
        await pool.query('SELECT id, email, name, role FROM "User" WHERE id = $1 LIMIT 1', [
          configuredId,
        ])
      ).rows[0]
    : (
        await pool.query(
          'SELECT id, email, name, role FROM "User" WHERE lower(email) = lower($1) LIMIT 1',
          [configuredEmail]
        )
      ).rows[0]

  let sales = null
  if (active?.id) {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const today = (
      await pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"),0)::float AS total
         FROM "POSTransaction"
         WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false AND "createdAt" >= $2`,
        [active.id, start]
      )
    ).rows[0]
    const all = (
      await pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"),0)::float AS total, MAX("createdAt") AS last
         FROM "POSTransaction"
         WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false`,
        [active.id]
      )
    ).rows[0]
    sales = { today, all }
  }

  const top = (
    await pool.query(`
      SELECT u.email, u.name,
             COUNT(t.id)::int AS txs,
             COALESCE(SUM(t."totalAmount"),0)::float AS total,
             MAX(t."createdAt") AS last
      FROM "User" u
      INNER JOIN "POSTransaction" t ON t."userId" = u.id
      WHERE t.status = 'COMPLETED'
      GROUP BY u.email, u.name
      ORDER BY last DESC NULLS LAST
      LIMIT 8
    `)
  ).rows

  console.log(
    JSON.stringify(
      {
        configuredEmail,
        activeAccount: active || null,
        totalUsers,
        usersWithPos,
        salesForActiveAccount: sales,
        merchantsWithMostRecentPos: top,
      },
      null,
      2
    )
  )
  await pool.end()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
