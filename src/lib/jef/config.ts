export type JefConfig = {
  openRouter: {
    apiKey: string
    /** Full OpenRouter model id, e.g. typesafe/jev-1.13 */
    model: string
    /** Provider slug, e.g. typesafe */
    provider: string
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

/**
 * OpenRouter IDs are `provider/model`.
 * Users may set OPENROUTER_MODEL=jev-1.13 and OPENROUTER_PROVIDER=typesafe.
 */
export function resolveOpenRouterModelId(input: {
  model?: string
  provider?: string
}): string {
  const provider = (input.provider || 'typesafe').trim().replace(/\/$/, '') || 'typesafe'
  let model = (input.model || 'jev-1.13').trim()

  // Already a full slug: typesafe/jev-1.13
  if (model.includes('/')) {
    const [p, ...rest] = model.split('/')
    const name = rest.join('/')
    if (!name) return `${provider}/jev-1.13`
    // If they passed only provider by mistake, fall back
    if (!name || name === p) return `${provider}/jev-1.13`
    return `${p}/${name}`
  }

  return `${provider}/${model}`
}

export function getJefConfig(): JefConfig {
  const provider = process.env.OPENROUTER_PROVIDER?.trim() || 'typesafe'
  const modelRaw = process.env.OPENROUTER_MODEL?.trim() || 'jev-1.13'

  return {
    openRouter: {
      apiKey: process.env.OPENROUTER_API_KEY?.trim() || '',
      provider,
      model: resolveOpenRouterModelId({ model: modelRaw, provider }),
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
