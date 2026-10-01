import { Pool, type QueryResultRow } from 'pg'
import { getJefConfig } from './config'

let pool: Pool | null = null

function getPool(): Pool {
  const url = getJefConfig().databaseUrl
  if (!url) throw new Error('DATABASE_URL is not configured')
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      // Tejarify agency Postgres often has no SSL; enable only when requested.
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    })
  }
  return pool
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params)
  return result.rows
}

export async function resolveMerchantUserId(): Promise<string> {
  const config = getJefConfig()
  if (config.tejarifyUserId) return config.tejarifyUserId

  if (config.tejarifyUserEmail) {
    const rows = await dbQuery<{ id: string }>(
      `SELECT id FROM "User" WHERE lower(email) = lower($1) LIMIT 1`,
      [config.tejarifyUserEmail]
    )
    if (rows[0]?.id) return rows[0].id
    throw new Error(`No Tejarify user found for TEJARIFY_USER_EMAIL=${config.tejarifyUserEmail}`)
  }

  // Fallback: merchant with the most recent POS activity
  const rows = await dbQuery<{ id: string }>(
    `SELECT u.id
     FROM "User" u
     INNER JOIN "POSTransaction" t ON t."userId" = u.id
     GROUP BY u.id
     ORDER BY MAX(t."createdAt") DESC
     LIMIT 1`
  )
  if (rows[0]?.id) return rows[0].id
  throw new Error('Could not resolve a Tejarify merchant user. Set TEJARIFY_USER_EMAIL or TEJARIFY_USER_ID.')
}
