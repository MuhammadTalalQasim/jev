import { dbQuery, resolveMerchantUserId } from './db'
import { parsePeriod } from './period'
import type { OpenAiTool, ToolDefinition } from './types'

const searchParams: Record<string, unknown> = {
  type: 'object',
  properties: {
    q: {
      type: 'string',
      description:
        'Natural-language query or period, e.g. "today", "this week", "this month", product/customer name.',
    },
    limit: {
      type: 'number',
      minimum: 1,
      maximum: 50,
      description: 'Max rows to return (default 10).',
    },
  },
  additionalProperties: false,
}

function limitOf(args: Record<string, unknown>, fallback = 10) {
  const n = typeof args.limit === 'number' ? args.limit : fallback
  return Math.min(Math.max(Math.floor(n), 1), 50)
}

/**
 * Tool registry backed by the Tejarify Postgres DB (DATABASE_URL).
 * Add new tools here without changing the OpenRouter agent loop.
 */
export function createToolRegistry(): Record<string, ToolDefinition> {
  return {
    getTodayPosSales: {
      name: 'getTodayPosSales',
      description:
        "Get today's POS completed sales total, transaction count, and till sessions for the merchant.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      label: "Checking today's POS sales",
      execute: async () => {
        const userId = await resolveMerchantUserId()
        const range = parsePeriod('today')
        const [sales] = await dbQuery<{ count: string; total: string | null }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS total
           FROM "POSTransaction"
           WHERE "userId" = $1
             AND status = 'COMPLETED'
             AND "isVoided" = false
             AND "createdAt" >= $2
             AND "createdAt" <= $3`,
          [userId, range.start, range.end]
        )
        const sessions = await dbQuery(
          `SELECT id, status, "openingCash", "closingCash", "totalSales", "totalTransactions", "terminalId", "createdAt"
           FROM "POSSession"
           WHERE "userId" = $1 AND "createdAt" >= $2
           ORDER BY "createdAt" DESC
           LIMIT 8`,
          [userId, range.start]
        )
        const completedSales = Number(sales?.total || 0)
        const completedCount = Number(sales?.count || 0)
        const [last] = await dbQuery<{ last: Date | null; total: string | null }>(
          `SELECT MAX("createdAt") AS last, COALESCE(SUM("totalAmount"), 0)::float AS total
           FROM "POSTransaction"
           WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false`,
          [userId]
        )
        return {
          summary:
            completedCount > 0
              ? `Today's POS sales: ${completedCount} transactions, total ${completedSales}.`
              : `No POS sales recorded today. Last completed POS activity: ${last?.last ? new Date(last.last).toISOString() : 'none'}.`,
          data: {
            period: 'today',
            completedSales,
            completedCount,
            sessions,
            lastCompletedAt: last?.last || null,
          },
        }
      },
    },

    getSalesForPeriod: {
      name: 'getSalesForPeriod',
      description:
        'Get POS + B2B invoice sales for a period. Put period in q: today, this week, this month, last month, yesterday.',
      parameters: searchParams,
      label: 'Looking up sales for the period',
      execute: async (args) => {
        const userId = await resolveMerchantUserId()
        const range = parsePeriod(typeof args.q === 'string' ? args.q : 'today')
        const [pos] = await dbQuery<{ count: string; total: string | null }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS total
           FROM "POSTransaction"
           WHERE "userId" = $1
             AND status = 'COMPLETED'
             AND "isVoided" = false
             AND "createdAt" >= $2
             AND "createdAt" <= $3`,
          [userId, range.start, range.end]
        )
        const [b2b] = await dbQuery<{ count: string; total: string | null }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM("grandTotal"), 0)::float AS total
           FROM "Invoice"
           WHERE "userId" = $1
             AND status <> 'CANCELLED'
             AND "createdAt" >= $2
             AND "createdAt" <= $3`,
          [userId, range.start, range.end]
        ).catch(() => [{ count: '0', total: '0' }])

        const posTotal = Number(pos?.total || 0)
        const posCount = Number(pos?.count || 0)
        const b2bTotal = Number(b2b?.total || 0)
        const b2bCount = Number(b2b?.count || 0)

        return {
          summary: `Sales for ${range.label}: POS ${posTotal} (${posCount}), B2B ${b2bTotal} (${b2bCount}).`,
          data: {
            period: range.label,
            pos: { count: posCount, total: posTotal },
            b2b: { count: b2bCount, total: b2bTotal },
            combined: posTotal + b2bTotal,
          },
        }
      },
    },

    searchPosTransactions: {
      name: 'searchPosTransactions',
      description: 'List recent completed POS transactions. Optional q matches transaction number.',
      parameters: searchParams,
      label: 'Searching POS transactions',
      execute: async (args) => {
        const userId = await resolveMerchantUserId()
        const limit = limitOf(args)
        const q = typeof args.q === 'string' ? args.q.trim() : ''
        const rows = await dbQuery(
          `SELECT id, "transactionNumber", "totalAmount", "paymentMethod", status, "createdAt"
           FROM "POSTransaction"
           WHERE "userId" = $1
             AND status = 'COMPLETED'
             AND "isVoided" = false
             AND ($2 = '' OR "transactionNumber" ILIKE '%' || $2 || '%')
           ORDER BY "createdAt" DESC
           LIMIT $3`,
          [userId, q, limit]
        )
        return {
          summary: `Found ${rows.length} POS transaction(s).`,
          data: { transactions: rows },
        }
      },
    },

    getLowStock: {
      name: 'getLowStock',
      description: 'List products/variations that appear low on stock (quantity <= 5).',
      parameters: searchParams,
      label: 'Checking low stock',
      execute: async (args) => {
        const userId = await resolveMerchantUserId()
        const limit = limitOf(args)
        // ProductVariation is the common Tejarify stock unit; fall back gracefully if schema differs.
        const rows = await dbQuery(
          `SELECT pv.id, p.name AS "productName", pv.sku, pv.barcode, pv."stockQuantity", pv."sellingPrice", pv."minStockLevel"
           FROM "ProductVariation" pv
           INNER JOIN "Product" p ON p.id = pv."productId"
           WHERE pv."userId" = $1
             AND pv."isActive" = true
             AND pv."stockQuantity" <= GREATEST(pv."minStockLevel", 5)
           ORDER BY pv."stockQuantity" ASC
           LIMIT $2`,
          [userId, limit]
        )
        return {
          summary: `Found ${rows.length} low-stock item(s).`,
          data: { items: rows },
        }
      },
    },

    searchProducts: {
      name: 'searchProducts',
      description: 'Search products by name, SKU, or barcode using q.',
      parameters: searchParams,
      label: 'Searching products',
      execute: async (args) => {
        const userId = await resolveMerchantUserId()
        const limit = limitOf(args)
        const q = typeof args.q === 'string' ? args.q.trim() : ''
        if (!q) {
          return { summary: 'Provide a product name, SKU, or barcode in q.', data: { items: [] } }
        }
        const rows = await dbQuery(
          `SELECT p.id, p.name, pv.sku, pv.barcode, pv."stockQuantity", pv."sellingPrice"
           FROM "Product" p
           LEFT JOIN "ProductVariation" pv ON pv."productId" = p.id
           WHERE p."userId" = $1
             AND (
               p.name ILIKE '%' || $2 || '%'
               OR COALESCE(pv.sku, '') ILIKE '%' || $2 || '%'
               OR COALESCE(pv.barcode, '') ILIKE '%' || $2 || '%'
             )
           ORDER BY p.name ASC
           LIMIT $3`,
          [userId, q, limit]
        )
        return {
          summary: `Found ${rows.length} product match(es) for "${q}".`,
          data: { items: rows },
        }
      },
    },

    getBusinessDashboard: {
      name: 'getBusinessDashboard',
      description: 'High-level snapshot: today POS sales and open sessions.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      label: 'Loading business dashboard',
      execute: async () => {
        const userId = await resolveMerchantUserId()
        const today = parsePeriod('today')
        const month = parsePeriod('this month')
        const [todayPos] = await dbQuery<{ count: string; total: string | null }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS total
           FROM "POSTransaction"
           WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false
             AND "createdAt" >= $2 AND "createdAt" <= $3`,
          [userId, today.start, today.end]
        )
        const [monthPos] = await dbQuery<{ count: string; total: string | null }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM("totalAmount"), 0)::float AS total
           FROM "POSTransaction"
           WHERE "userId" = $1 AND status = 'COMPLETED' AND "isVoided" = false
             AND "createdAt" >= $2 AND "createdAt" <= $3`,
          [userId, month.start, month.end]
        )
        return {
          summary: 'Business dashboard snapshot loaded.',
          data: {
            todayPos: {
              count: Number(todayPos?.count || 0),
              total: Number(todayPos?.total || 0),
            },
            monthPos: {
              count: Number(monthPos?.count || 0),
              total: Number(monthPos?.total || 0),
            },
          },
        }
      },
    },
  }
}

export function toolsToOpenAiFormat(registry: Record<string, ToolDefinition>): OpenAiTool[] {
  return Object.values(registry).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw?.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    throw new Error('Tool arguments must be a JSON object')
  } catch (error) {
    if (error instanceof Error && error.message.includes('must be')) throw error
    throw new Error('Invalid tool arguments: expected JSON object')
  }
}
