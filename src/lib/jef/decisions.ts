import type { JefConfig } from './config'
import { parseOpenRouterUsage, type TokenUsage } from './usage'

export type DecisionQuestion =
  | {
      type: 'choice'
      instructions: string
      criteria: Record<string, string>
    }
  | {
      type: 'noul'
      instructions: string
      criteria: { true: string; false: string }
    }
  | {
      type: 'score'
      instructions: string
      criteria: string[]
    }

export type DecisionAnswers = Record<
  string,
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number>; legend?: Record<string, string> }
>

export type DecisionsResult = {
  answers: DecisionAnswers
  usage: TokenUsage
  model?: string
  raw: unknown
}

/**
 * OpenRouter Decisions API client for typesafe/jev-* models.
 * Docs: https://openrouter.ai/docs/guides/community/jev
 */
export async function openRouterDecisions(input: {
  config: JefConfig['openRouter']
  state: unknown
  questions: Record<string, DecisionQuestion>
}): Promise<DecisionsResult> {
  const { config } = input
  if (!config.apiKey) throw new Error('OpenRouter API key is not configured')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (config.siteUrl) headers['HTTP-Referer'] = config.siteUrl
  if (config.siteName) headers['X-Title'] = config.siteName

  // Decisions live under /api/alpha, not /api/v1/chat/completions
  const url = 'https://openrouter.ai/api/alpha/decisions'

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        state: input.state,
        questions: input.questions,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Network error'
    throw new Error(`OpenRouter Decisions request failed: ${msg}`)
  }

  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`OpenRouter Decisions returned invalid JSON (${res.status})`)
  }

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 280)
    throw new Error(`OpenRouter Decisions error ${res.status}: ${detail}`)
  }

  if (!json?.answers || typeof json.answers !== 'object') {
    throw new Error('OpenRouter Decisions returned an unexpected response shape')
  }

  return {
    answers: json.answers as DecisionAnswers,
    usage: parseOpenRouterUsage(json),
    model: typeof json.model === 'string' ? json.model : config.model,
    raw: json,
  }
}

export function choiceOf(answers: DecisionAnswers, key: string, fallback = ''): string {
  const a = answers[key]
  if (a && a.type === 'choice' && typeof a.choice === 'string') return a.choice
  return fallback
}

export function noulYes(answers: DecisionAnswers, key: string, threshold = 0.55): boolean {
  const a = answers[key]
  if (a && a.type === 'noul') return a.noul >= threshold
  return false
}
