export type JefConfig = {
  openRouter: {
    apiKey: string
    model: string
    baseUrl: string
    siteUrl?: string
    siteName: string
    timeoutMs: number
  }
  /** Prefer database when DATABASE_URL is set (typical for local Jef testing). */
  databaseUrl: string
  /** Merchant owner user id or email used to scope Tejarify queries. */
  tejarifyUserId: string
  tejarifyUserEmail: string
  maxToolRounds: number
}

export function getJefConfig(): JefConfig {
  return {
    openRouter: {
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
      model: process.env.OPENROUTER_MODEL?.trim() || 'openai/gpt-4o-mini',
      baseUrl: (process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1').replace(
        /\/$/,
        ''
      ),
      siteUrl: process.env.OPENROUTER_SITE_URL?.trim() || undefined,
      siteName: process.env.OPENROUTER_SITE_NAME?.trim() || 'Jef',
      timeoutMs: Number(process.env.JEF_AI_TIMEOUT_MS || 60000),
    },
    databaseUrl: process.env.DATABASE_URL?.trim().replace(/^"|"$/g, '') || '',
    tejarifyUserId: process.env.TEJARIFY_USER_ID?.trim() || '',
    tejarifyUserEmail: process.env.TEJARIFY_USER_EMAIL?.trim() || process.env.ADMIN_EMAIL?.trim() || '',
    maxToolRounds: Math.min(Math.max(Number(process.env.JEF_MAX_TOOL_ROUNDS || 6), 1), 12),
  }
}

export function assertJefReady(): JefConfig {
  const config = getJefConfig()
  if (!config.openRouter.apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured')
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not configured (Tejarify Postgres connection)')
  }
  return config
}
