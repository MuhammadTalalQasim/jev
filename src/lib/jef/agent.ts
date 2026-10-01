import { assertJefReady } from './config'
import { openRouterChatCompletion } from './openrouter'
import { buildJefSystemPrompt } from './system-prompt'
import { createToolRegistry, parseToolArgs, toolsToOpenAiFormat } from './tools'
import type {
  JefAgentResult,
  JefChatMessage,
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

function toHistory(history: JefClientMessage[]): JefChatMessage[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }))
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

/**
 * Tool-calling loop:
 * User → OpenRouter → (tool call → Tejarify execute → tool result → OpenRouter)* → final answer
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

  let config
  try {
    config = assertJefReady()
  } catch (error) {
    throw new JefAgentError(
      error instanceof Error ? error.message : 'Jef is not configured',
      503
    )
  }

  const registry = createToolRegistry()
  const tools = toolsToOpenAiFormat(registry)

  const messages: JefChatMessage[] = [
    { role: 'system', content: buildJefSystemPrompt() },
    ...toHistory(input.history || []),
    { role: 'user', content: message },
  ]

  const toolActivities: JefToolActivity[] = []
  let rounds = 0
  let usage = emptyUsage()

  while (rounds < config.maxToolRounds) {
    rounds += 1

    let completion
    const apiStarted = Date.now()
    try {
      completion = await openRouterChatCompletion({
        config: config.openRouter,
        messages,
        tools,
        temperature: 0.2,
        maxTokens: 1600,
      })
    } catch (error) {
      throw new JefAgentError(
        error instanceof Error ? error.message : 'OpenRouter request failed',
        502
      )
    } finally {
      apiMs += Date.now() - apiStarted
    }

    usage = addUsage(usage, completion.usage)

    const assistant = completion.message
    messages.push({
      role: 'assistant',
      content: assistant.content,
      tool_calls: assistant.tool_calls,
    })

    const toolCalls = assistant.tool_calls || []
    if (!toolCalls.length) {
      const answer = (assistant.content || '').trim()
      if (!answer) {
        throw new JefAgentError('Jef returned an empty response. Please try again.', 502)
      }
      return {
        answer,
        toolActivities,
        provider: { code: 'openrouter', model: config.openRouter.model },
        rounds,
        usage: finalizeUsage(config.openRouter.model, usage),
        timing: buildTiming(startedAt, apiMs, toolsMs),
      }
    }

    for (const call of toolCalls) {
      const toolName = call.function?.name?.trim() || ''
      const toolCallId = call.id || `call_${toolName || 'unknown'}`

      if (!toolName || !registry[toolName]) {
        const err = toolName
          ? `Unknown tool "${toolName}". Only registered tools can run.`
          : 'Tool name missing'
        toolActivities.push({
          toolCallId,
          toolName: toolName || 'unknown',
          label: 'Unknown tool',
          status: 'error',
          error: err,
        })
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: toolName || undefined,
          content: JSON.stringify({ ok: false, error: err }),
        })
        continue
      }

      const tool = registry[toolName]
      let args: Record<string, unknown>
      try {
        args = parseToolArgs(call.function.arguments || '{}')
      } catch (error) {
        const err = error instanceof Error ? error.message : 'Invalid tool arguments'
        toolActivities.push({
          toolCallId,
          toolName,
          label: tool.label,
          status: 'error',
          error: err,
        })
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: toolName,
          content: JSON.stringify({ ok: false, error: err }),
        })
        continue
      }

      const toolStarted = Date.now()
      try {
        const result = await tool.execute(args)
        toolsMs += Date.now() - toolStarted
        toolActivities.push({
          toolCallId,
          toolName,
          label: tool.label,
          status: 'success',
          summary: result.summary,
        })
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: toolName,
          content: JSON.stringify({
            ok: true,
            summary: result.summary,
            data: result.data,
          }),
        })
      } catch (error) {
        toolsMs += Date.now() - toolStarted
        const err = error instanceof Error ? error.message : 'Tool execution failed'
        console.error('[jef] tool failed', toolName, err)
        toolActivities.push({
          toolCallId,
          toolName,
          label: tool.label,
          status: 'error',
          error: err,
        })
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          name: toolName,
          content: JSON.stringify({ ok: false, error: err }),
        })
      }
    }
  }

  throw new JefAgentError(
    'Jef stopped after too many tool steps. Please rephrase your question.',
    504
  )
}
