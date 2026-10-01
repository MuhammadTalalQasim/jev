import { NextResponse } from 'next/server'
import { JefAgentError, runJefAgent, type JefClientMessage } from '@/lib/jef'

export const runtime = 'nodejs'

function publicError(error: unknown): { message: string; status: number } {
  if (error instanceof JefAgentError) {
    return { message: error.message, status: error.status }
  }
  if (error instanceof Error) {
    const safe = error.message.replace(/sk-[a-zA-Z0-9_-]+/g, '[redacted]').replace(/mshi_[a-zA-Z0-9_-]+/g, '[redacted]')
    return { message: safe.slice(0, 280), status: 500 }
  }
  return { message: 'Something went wrong while talking to Jef.', status: 500 }
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  try {
    const body = await request.json().catch(() => ({}))
    const message = String(body.message || body.question || '').trim()
    const history = Array.isArray(body.history) ? (body.history as JefClientMessage[]) : []

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required', requestTimeMs: Date.now() - startedAt },
        { status: 400 }
      )
    }

    const result = await runJefAgent({ message, history })
    const requestTimeMs = Date.now() - startedAt

    return NextResponse.json({
      answer: result.answer,
      toolActivities: result.toolActivities,
      provider: result.provider,
      rounds: result.rounds,
      requestTimeMs,
      usage: result.usage,
      costUsd: result.usage.costUsd,
      timing: result.timing,
    })
  } catch (error) {
    console.error('[jef/api]', error instanceof Error ? error.message : error)
    const { message, status } = publicError(error)
    return NextResponse.json(
      { error: message, requestTimeMs: Date.now() - startedAt },
      { status }
    )
  }
}
