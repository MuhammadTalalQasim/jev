import { assertJefReady } from './config'
import { choiceOf, noulYes, openRouterDecisions } from './decisions'
import { createToolRegistry } from './tools'
import type {
  JefAgentResult,
  JefClientMessage,
  JefTiming,
  JefToolActivity,
} from './types'
import { addUsage, emptyUsage, estimateCostUsd } from './usage'

export class JefAgentError extends Error {
  status: number

  constructor(message: string, status = 500) {
    super(message)
    this.name = 'JefAgentError'
    this.status = status
  }
}

function finalizeUsage(model: string, usage: ReturnType<typeof emptyUsage>) {
  const hasNativeCost = typeof usage.costUsd === 'number'
  const costUsd = estimateCostUsd(model, usage)
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    costUsd,
    costSource: hasNativeCost ? ('openrouter' as const) : ('estimate' as const),
  }
}

function buildTiming(startedAt: number, apiMs: number, toolsMs: number): JefTiming {
  return {
    apiMs: Math.max(0, Math.round(apiMs)),
    toolsMs: Math.max(0, Math.round(toolsMs)),
    jefMs: Math.max(0, Math.round(Date.now() - startedAt)),
  }
}

function historyState(history: JefClientMessage[] | undefined, message: string) {
  const recent = (history || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
  return {
    app: 'Tejarify merchant assistant',
    user_message: message,
    recent_conversation: recent || null,
  }
}

function formatMoney(n: number) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

function periodQuery(period: string): string {
  switch (period) {
    case 'yesterday':
      return 'yesterday'
    case 'this_week':
      return 'this week'
    case 'last_week':
      return 'last week'
    case 'this_month':
      return 'this month'
    case 'last_month':
      return 'last month'
    case 'today':
    default:
      return 'today'
  }
}

function answerFromTool(
  intent: string,
  period: string,
  toolName: string | null,
  data: unknown,
  summary: string
): string {
  const d = (data || {}) as Record<string, any>

  if (intent === 'greeting') {
    return 'Hello — I am Jef, your Tejarify business assistant. Ask me about POS sales, stock, products, or your dashboard.'
  }

  if (intent === 'today_pos' || toolName === 'getTodayPosSales') {
    const count = Number(d.completedCount || 0)
    const total = Number(d.completedSales || 0)
    if (count === 0) {
      const last = d.lastCompletedAt
        ? ` Last completed POS activity was ${new Date(d.lastCompletedAt).toLocaleString()}.`
        : ''
      return `**Today's POS sales:** no completed transactions yet.${last}`
    }
    return `**Today's POS sales**\n\n- Transactions: **${count}**\n- Total: **${formatMoney(total)}**`
  }

  if (intent === 'sales_period' || toolName === 'getSalesForPeriod') {
    const label = d.period || periodQuery(period)
    const pos = d.pos || {}
    const b2b = d.b2b || {}
    return [
      `**Sales for ${label}**`,
      '',
      `- POS: **${formatMoney(Number(pos.total || 0))}** (${Number(pos.count || 0)} txns)`,
      `- B2B: **${formatMoney(Number(b2b.total || 0))}** (${Number(b2b.count || 0)} invoices)`,
      `- Combined: **${formatMoney(Number(d.combined || 0))}**`,
    ].join('\n')
  }

  if (intent === 'dashboard' || toolName === 'getBusinessDashboard') {
    const today = d.todayPos || {}
    const month = d.monthPos || {}
    return [
      '**Business snapshot**',
      '',
      `- Today POS: **${formatMoney(Number(today.total || 0))}** (${Number(today.count || 0)} txns)`,
      `- This month POS: **${formatMoney(Number(month.total || 0))}** (${Number(month.count || 0)} txns)`,
    ].join('\n')
  }

  if (intent === 'low_stock' || toolName === 'getLowStock') {
    const items = Array.isArray(d.items) ? d.items : []
    if (!items.length) return 'No low-stock items found.'
    const lines = items
      .slice(0, 8)
      .map(
        (item: any) =>
          `- ${item.productName || item.name || 'Item'}: stock **${item.stockQuantity ?? item.quantity ?? '—'}**`
      )
    return `**Low stock**\n\n${lines.join('\n')}`
  }

  if (intent === 'search_products' || toolName === 'searchProducts') {
    const items = Array.isArray(d.items) ? d.items : []
    if (!items.length) return 'No products matched that search.'
    const lines = items
      .slice(0, 8)
      .map(
        (item: any) =>
          `- ${item.name || item.productName}: SKU ${item.sku || '—'}, stock ${item.stockQuantity ?? '—'}, price ${formatMoney(Number(item.sellingPrice || 0))}`
      )
    return `**Products**\n\n${lines.join('\n')}`
  }

  if (intent === 'search_pos' || toolName === 'searchPosTransactions') {
    const rows = Array.isArray(d.transactions) ? d.transactions : []
    if (!rows.length) return 'No POS transactions found.'
    const lines = rows
      .slice(0, 8)
      .map(
        (row: any) =>
          `- ${row.transactionNumber}: **${formatMoney(Number(row.totalAmount || 0))}** (${row.paymentMethod || '—'})`
      )
    return `**Recent POS transactions**\n\n${lines.join('\n')}`
  }

  return summary || 'Here is what I found from Tejarify.'
}

/**
 * Jef agent powered only by OpenRouter Decisions model (typesafe/jev-*).
 * Flow: Decisions route → Tejarify tools → templated merchant reply.
 */
export async function runJefAgent(input: {
  message: string
  history?: JefClientMessage[]
}): Promise<JefAgentResult> {
  const message = input.message.trim()
  if (!message) throw new JefAgentError('Message is required', 400)

  const startedAt = Date.now()
  let apiMs = 0
  let toolsMs = 0
  let usage = emptyUsage()

  let config
  try {
    config = assertJefReady()
  } catch (error) {
    throw new JefAgentError(
      error instanceof Error ? error.message : 'Jef is not configured',
      503
    )
  }

  const model = config.openRouter.model
  const registry = createToolRegistry()
  const toolActivities: JefToolActivity[] = []

  const apiStarted = Date.now()
  let decision
  try {
    decision = await openRouterDecisions({
      config: config.openRouter,
      state: historyState(input.history, message),
      questions: {
        needs_data: {
          type: 'noul',
          instructions: 'Does the merchant need Tejarify business data (sales, stock, products, dashboard)?',
          criteria: {
            true: 'They ask about sales, POS, revenue, stock, products, customers, or dashboard metrics.',
            false: 'They are greeting, thanking, or making small talk with no data request.',
          },
        },
        intent: {
          type: 'choice',
          instructions: 'Which Tejarify action best matches the merchant message?',
          criteria: {
            today_pos: 'Ask for today POS sales, till, or today retail sales.',
            sales_period: 'Ask for sales/revenue over a period like week or month.',
            dashboard: 'Ask for overview, snapshot, or dashboard summary.',
            low_stock: 'Ask which products are low on stock or out of stock.',
            search_products: 'Ask to find a product by name, SKU, or barcode.',
            search_pos: 'Ask to list or search recent POS transactions/receipts.',
            greeting: 'Greeting or small talk only.',
            unsupported: 'Something else not covered by the options above.',
          },
        },
        period: {
          type: 'choice',
          instructions: 'If this is a sales question, which period do they mean?',
          criteria: {
            today: 'Today / current day.',
            yesterday: 'Yesterday.',
            this_week: 'This week.',
            last_week: 'Last week.',
            this_month: 'This month.',
            last_month: 'Last month.',
            unclear: 'No clear period or not a sales question.',
          },
        },
      },
    })
  } catch (error) {
    throw new JefAgentError(
      error instanceof Error ? error.message : 'OpenRouter Decisions request failed',
      502
    )
  } finally {
    apiMs += Date.now() - apiStarted
  }

  usage = addUsage(usage, decision.usage)
  const intent = choiceOf(decision.answers, 'intent', 'unsupported')
  const period = choiceOf(decision.answers, 'period', 'today')
  const needsData = noulYes(decision.answers, 'needs_data')

  if (!needsData || intent === 'greeting') {
    return {
      answer: answerFromTool('greeting', period, null, null, ''),
      toolActivities,
      provider: { code: 'openrouter', model: decision.model || model },
      rounds: 1,
      usage: finalizeUsage(model, usage),
      timing: buildTiming(startedAt, apiMs, toolsMs),
    }
  }

  const toolByIntent: Record<string, string> = {
    today_pos: 'getTodayPosSales',
    sales_period: 'getSalesForPeriod',
    dashboard: 'getBusinessDashboard',
    low_stock: 'getLowStock',
    search_products: 'searchProducts',
    search_pos: 'searchPosTransactions',
  }

  const toolName = toolByIntent[intent]
  if (!toolName || !registry[toolName]) {
    return {
      answer:
        'I can help with today’s POS sales, sales by period, low stock, product search, recent POS transactions, and dashboard snapshots. Please ask one of those.',
      toolActivities,
      provider: { code: 'openrouter', model: decision.model || model },
      rounds: 1,
      usage: finalizeUsage(model, usage),
      timing: buildTiming(startedAt, apiMs, toolsMs),
    }
  }

  const tool = registry[toolName]
  const args: Record<string, unknown> = {}
  if (toolName === 'getSalesForPeriod') {
    args.q = periodQuery(period === 'unclear' ? 'today' : period)
  } else if (toolName === 'searchProducts' || toolName === 'searchPosTransactions') {
    args.q = message.slice(0, 200)
    args.limit = 10
  } else if (toolName === 'getLowStock') {
    args.limit = 10
  }

  const toolStarted = Date.now()
  try {
    const result = await tool.execute(args)
    toolsMs += Date.now() - toolStarted
    toolActivities.push({
      toolCallId: `call_${toolName}`,
      toolName,
      label: tool.label,
      status: 'success',
      summary: result.summary,
    })

    return {
      answer: answerFromTool(intent, period, toolName, result.data, result.summary),
      toolActivities,
      provider: { code: 'openrouter', model: decision.model || model },
      rounds: 1,
      usage: finalizeUsage(model, usage),
      timing: buildTiming(startedAt, apiMs, toolsMs),
    }
  } catch (error) {
    toolsMs += Date.now() - toolStarted
    const err = error instanceof Error ? error.message : 'Tool execution failed'
    toolActivities.push({
      toolCallId: `call_${toolName}`,
      toolName,
      label: tool.label,
      status: 'error',
      error: err,
    })
    return {
      answer: `I understood your request, but Tejarify data lookup failed: ${err}`,
      toolActivities,
      provider: { code: 'openrouter', model: decision.model || model },
      rounds: 1,
      usage: finalizeUsage(model, usage),
      timing: buildTiming(startedAt, apiMs, toolsMs),
    }
  }
}
