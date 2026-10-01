export type TokenUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** OpenRouter native cost in USD when available. */
  costUsd: number | null
}

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const costParts = [a.costUsd, b.costUsd].filter((v): v is number => typeof v === 'number')
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: costParts.length ? costParts.reduce((sum, v) => sum + v, 0) : null,
  }
}

export function parseOpenRouterUsage(json: any): TokenUsage {
  const usage = json?.usage || {}
  const promptTokens = Number(usage.prompt_tokens || usage.input_tokens || 0) || 0
  const completionTokens = Number(usage.completion_tokens || usage.output_tokens || 0) || 0
  const totalTokens =
    Number(usage.total_tokens || 0) || promptTokens + completionTokens

  let costUsd: number | null = null
  if (typeof usage.cost === 'number') costUsd = usage.cost
  else if (typeof json?.cost === 'number') costUsd = json.cost
  else if (typeof usage.total_cost === 'number') costUsd = usage.total_cost

  return { promptTokens, completionTokens, totalTokens, costUsd }
}

/**
 * Fallback estimate when OpenRouter does not return `usage.cost`.
 * Prices are approximate USD per 1M tokens for common chat models.
 */
const MODEL_RATES: Record<string, { input: number; output: number }> = {
  'jev-1.13': { input: 0.042, output: 0 },
  'typesafe/jev-1.13': { input: 0.042, output: 0 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-4o': { input: 2.5, output: 10 },
  'openai/gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'anthropic/claude-3.5-sonnet': { input: 3, output: 15 },
  'google/gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'google/gemini-2.5-flash': { input: 0.3, output: 2.5 },
}

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  if (typeof usage.costUsd === 'number') return usage.costUsd
  const short = model.includes('/') ? model.split('/').pop() || model : model
  const rates = MODEL_RATES[model] || MODEL_RATES[short] || { input: 0.15, output: 0.6 }
  return (usage.promptTokens / 1_000_000) * rates.input + (usage.completionTokens / 1_000_000) * rates.output
}

export function formatCostUsd(cost: number | null | undefined): string | null {
  if (cost == null || !Number.isFinite(cost) || cost < 0) return null
  if (cost === 0) return '$0.00'
  if (cost < 0.0001) return `$${cost.toFixed(6)}`
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}
