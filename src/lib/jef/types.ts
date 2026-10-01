export type JefRole = 'system' | 'user' | 'assistant' | 'tool'

export type JefToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** Wire format for OpenRouter (no UI-only fields). */
export type JefChatMessage = {
  role: JefRole
  content: string | null
  tool_call_id?: string
  name?: string
  tool_calls?: JefToolCall[]
}

export type JefClientMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type JefToolActivity = {
  toolCallId: string
  toolName: string
  label: string
  status: 'success' | 'error'
  summary?: string
  error?: string
}

export type JefTiming = {
  /** OpenRouter / LLM API time (ms). */
  apiMs: number
  /** Tejarify tool / data lookup time (ms). */
  toolsMs: number
  /** Full Jef agent processing time (ms). */
  jefMs: number
}

export type JefAgentResult = {
  answer: string
  toolActivities: JefToolActivity[]
  provider: { code: 'openrouter'; model: string }
  rounds: number
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number
    costSource: 'openrouter' | 'estimate'
  }
  timing: JefTiming
}


export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  label: string
  execute: (args: Record<string, unknown>) => Promise<{ summary: string; data: unknown }>
}

export type OpenAiTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}
