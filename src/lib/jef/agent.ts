import { assertJefReady } from './config'
import { openRouterChatCompletion } from './openrouter'
import { buildJefSystemPrompt } from './system-prompt'
import { createToolRegistry, parseToolArgs, toolsToOpenAiFormat } from './tools'
import type {
  JefAgentResult,
  JefChatMessage,
  JefClientMessage,
  JefToolActivity,
} from './types'

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

  while (rounds < config.maxToolRounds) {
    rounds += 1

    let completion
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
    }

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

      try {
        const result = await tool.execute(args)
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
