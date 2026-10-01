import type { JefConfig } from './config'
import type { JefChatMessage, JefToolCall, OpenAiTool } from './types'
import { parseOpenRouterUsage, type TokenUsage } from './usage'

export type OpenRouterResult = {
  message: {
    role: 'assistant'
    content: string | null
    tool_calls?: JefToolCall[]
  }
  finishReason: string | null
  usage: TokenUsage
}

/**
 * Isolated OpenRouter client (OpenAI-compatible).
 * Swap model/baseUrl via env without touching the agent loop.
 */
export async function openRouterChatCompletion(input: {
  config: JefConfig['openRouter']
  messages: JefChatMessage[]
  tools?: OpenAiTool[]
  temperature?: number
  maxTokens?: number
}): Promise<OpenRouterResult> {
  const { config } = input
  if (!config.apiKey) throw new Error('OpenRouter API key is not configured')

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
  }
  if (config.siteUrl) headers['HTTP-Referer'] = config.siteUrl
  if (config.siteName) headers['X-Title'] = config.siteName

  const body: Record<string, unknown> = {
    model: config.model,
    messages: input.messages,
    temperature: input.temperature ?? 0.2,
    // Ask OpenRouter to include native cost in the response when available.
    usage: { include: true },
  }
  if (input.maxTokens) body.max_tokens = input.maxTokens
  if (input.tools?.length) {
    body.tools = input.tools
    body.tool_choice = 'auto'
  }

  let res: Response
  try {
    res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Network error'
    throw new Error(`OpenRouter request failed: ${msg}`)
  }

  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`OpenRouter returned invalid JSON (${res.status})`)
  }

  if (!res.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 280)
    throw new Error(`OpenRouter error ${res.status}: ${detail}`)
  }

  const choice = json?.choices?.[0]
  const message = choice?.message
  if (!message || message.role !== 'assistant') {
    throw new Error('OpenRouter returned an unexpected response shape')
  }

  return {
    message: {
      role: 'assistant',
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content == null
            ? null
            : String(message.content),
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
    },
    finishReason: choice?.finish_reason ?? null,
    usage: parseOpenRouterUsage(json),
  }
}
