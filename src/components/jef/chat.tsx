"use client"

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react"

type ToolActivity = {
  toolCallId: string
  toolName: string
  label: string
  status: "success" | "error"
  summary?: string
  error?: string
}

type TimingBreakdown = {
  apiMs: number
  toolsMs: number
  jefMs: number
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: string
  /** How long the request took, in milliseconds. */
  requestTimeMs?: number
  timing?: TimingBreakdown
  /** Estimated or reported request cost in USD. */
  costUsd?: number
  totalTokens?: number
  toolActivities?: ToolActivity[]
  isError?: boolean
  isLoading?: boolean
}

const SUGGESTIONS = [
  "What are today's POS sales?",
  "Show my sales this week",
  "Which products are low on stock?",
  "Who owes me money?",
]

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

function formatDuration(ms?: number) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}

function formatCostUsd(cost?: number) {
  if (cost == null || !Number.isFinite(cost) || cost < 0) return null
  if (cost === 0) return "$0.00"
  if (cost < 0.0001) return `$${cost.toFixed(6)}`
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

function compareLabel(timing: TimingBreakdown) {
  if (timing.apiMs === timing.toolsMs) return "API ≈ Tools"
  if (timing.apiMs > timing.toolsMs) {
    const delta = timing.apiMs - timing.toolsMs
    return `API +${formatDuration(delta)} vs Tools`
  }
  const delta = timing.toolsMs - timing.apiMs
  return `Tools +${formatDuration(delta)} vs API`
}

function renderContent(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-[var(--ink)]">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <span key={i}>{part}</span>
  })
}

export function JefChat() {
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, isSending])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [input])

  async function sendMessage(raw?: string) {
    const text = (raw ?? input).trim()
    if (!text || isSending) return

    setError(null)
    setInput("")
    setIsSending(true)

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    }
    const loadingId = crypto.randomUUID()
    const loadingMsg: ChatMessage = {
      id: loadingId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      isLoading: true,
    }

    setMessages((prev) => [...prev, userMsg, loadingMsg])

    const history = [...messages, userMsg]
      .filter((m) => !m.isLoading && !m.isError)
      .map((m) => ({ role: m.role, content: m.content }))

    const startedAt = performance.now()

    try {
      const res = await fetch("/api/jef/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
      })
      const data = await res.json().catch(() => ({}))
      const clientMs = Math.round(performance.now() - startedAt)
      const requestTimeMs =
        typeof data.requestTimeMs === "number" ? data.requestTimeMs : clientMs
      const costUsd =
        typeof data.costUsd === "number"
          ? data.costUsd
          : typeof data.usage?.costUsd === "number"
            ? data.usage.costUsd
            : undefined
      const totalTokens =
        typeof data.usage?.totalTokens === "number" ? data.usage.totalTokens : undefined
      const timing: TimingBreakdown | undefined =
        data.timing &&
        typeof data.timing.apiMs === "number" &&
        typeof data.timing.toolsMs === "number" &&
        typeof data.timing.jefMs === "number"
          ? {
              apiMs: data.timing.apiMs,
              toolsMs: data.timing.toolsMs,
              jefMs: data.timing.jefMs,
            }
          : {
              apiMs: 0,
              toolsMs: 0,
              jefMs: requestTimeMs,
            }
      const repliedAt = new Date().toISOString()

      if (!res.ok) {
        const msg = data.error || "Request failed. Please try again."
        setMessages((prev) =>
          prev.map((m) =>
            m.id === loadingId
              ? {
                  ...m,
                  isLoading: false,
                  isError: true,
                  content: msg,
                  timestamp: repliedAt,
                  requestTimeMs,
                  timing,
                  costUsd,
                  totalTokens,
                }
              : m
          )
        )
        setError(msg)
        return
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingId
            ? {
                ...m,
                isLoading: false,
                content: data.answer || "I couldn't find an answer.",
                timestamp: repliedAt,
                requestTimeMs,
                timing,
                costUsd,
                totalTokens,
                toolActivities: Array.isArray(data.toolActivities)
                  ? data.toolActivities
                  : [],
              }
            : m
        )
      )
    } catch {
      const requestTimeMs = Math.round(performance.now() - startedAt)
      const msg = "Network error. Check that Jef and Tejarify are running."
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingId
            ? {
                ...m,
                isLoading: false,
                isError: true,
                content: msg,
                timestamp: new Date().toISOString(),
                requestTimeMs,
              }
            : m
        )
      )
      setError(msg)
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void sendMessage()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }

  return (
    <div className="flex h-dvh flex-col bg-[var(--surface)] text-[var(--ink)]">
      <header className="shrink-0 border-b border-[var(--line)] bg-[var(--surface-elevated)]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div>
            <p className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[var(--brand)]">
              Jef
            </p>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              Tejarify business assistant
            </p>
          </div>
          <div className="hidden rounded-full border border-[var(--line)] px-3 py-1 text-xs text-[var(--muted)] sm:block">
            OpenRouter · live Tejarify data
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden px-4 sm:px-6">
        <div className="flex-1 space-y-5 overflow-y-auto py-6">
          {messages.length === 0 ? (
            <div className="flex h-full min-h-[50vh] flex-col items-center justify-center text-center">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--brand-soft)] text-[var(--brand)] shadow-[inset_0_0_0_1px_rgba(15,118,110,0.12)]">
                <span className="font-[family-name:var(--font-display)] text-3xl">J</span>
              </div>
              <h1 className="font-[family-name:var(--font-display)] text-3xl tracking-tight text-[var(--ink)]">
                Ask Jef about your business
              </h1>
              <p className="mt-2 max-w-md text-[var(--muted)]">
                Sales, POS, stock, customers — answered from your live Tejarify data.
              </p>
              <div className="mt-8 grid w-full max-w-lg gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void sendMessage(q)}
                    className="rounded-xl border border-[var(--line)] bg-[var(--surface-elevated)] px-4 py-3 text-left text-sm text-[var(--ink-soft)] transition hover:border-[var(--brand)]/40 hover:bg-[var(--brand-soft)]"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] sm:max-w-[85%] ${
                    m.role === "user" ? "items-end" : "items-start"
                  } flex flex-col gap-1.5`}
                >
                  {m.role === "assistant" && !m.isLoading && (
                    <span className="px-1 text-xs font-medium tracking-wide text-[var(--brand)]">
                      Jef
                    </span>
                  )}

                  {m.toolActivities && m.toolActivities.length > 0 && (
                    <div className="mb-1 flex flex-col gap-1 px-1">
                      {m.toolActivities.map((t) => (
                        <div key={t.toolCallId} className="flex flex-col gap-0.5">
                          <span
                            className={`w-fit rounded-md px-2 py-0.5 text-[11px] ${
                              t.status === "success"
                                ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                                : "bg-red-50 text-red-700"
                            }`}
                            title={t.error || t.summary || t.toolName}
                          >
                            {t.label}
                          </span>
                          {t.status === "error" && t.error ? (
                            <span className="text-[11px] text-red-600/90">{t.error}</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  <div
                    className={`whitespace-pre-wrap rounded-2xl px-4 py-3 text-[15px] leading-relaxed ${
                      m.role === "user"
                        ? "bg-[var(--brand)] text-white"
                        : m.isError
                          ? "border border-red-200 bg-red-50 text-red-800"
                          : "border border-[var(--line)] bg-[var(--surface-elevated)] text-[var(--ink)]"
                    }`}
                  >
                    {m.isLoading ? (
                      <span className="inline-flex items-center gap-2 text-[var(--muted)]">
                        <span className="jef-pulse h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
                        <span className="jef-pulse jef-pulse-delay-1 h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
                        <span className="jef-pulse jef-pulse-delay-2 h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />
                        <span className="ml-1">Thinking…</span>
                      </span>
                    ) : (
                      renderContent(m.content)
                    )}
                  </div>
                  <div className="flex flex-col gap-1 px-1">
                    <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--muted)]">
                      <span>{formatTime(m.timestamp)}</span>
                      {m.role === "assistant" && !m.isLoading && formatCostUsd(m.costUsd) ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{formatCostUsd(m.costUsd)}</span>
                        </>
                      ) : null}
                      {m.role === "assistant" &&
                      !m.isLoading &&
                      typeof m.totalTokens === "number" &&
                      m.totalTokens > 0 ? (
                        <>
                          <span aria-hidden>·</span>
                          <span>{m.totalTokens.toLocaleString()} tok</span>
                        </>
                      ) : null}
                    </div>

                    {m.role === "assistant" && !m.isLoading && m.timing ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <span className="rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] px-2 py-0.5 text-[var(--ink-soft)]">
                          API {formatDuration(m.timing.apiMs)}
                        </span>
                        <span className="rounded-md border border-[var(--line)] bg-[var(--surface-elevated)] px-2 py-0.5 text-[var(--ink-soft)]">
                          Tools {formatDuration(m.timing.toolsMs)}
                        </span>
                        <span className="rounded-md border border-[var(--brand)]/20 bg-[var(--brand-soft)] px-2 py-0.5 text-[var(--brand)]">
                          Jef {formatDuration(m.timing.jefMs)}
                        </span>
                        <span className="px-1 text-[var(--muted)]">
                          {compareLabel(m.timing)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {error && messages.length === 0 && (
          <p className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <form
          onSubmit={onSubmit}
          className="shrink-0 border-t border-[var(--line)] bg-[var(--surface)] pb-5 pt-3"
        >
          <div className="flex items-end gap-2 rounded-2xl border border-[var(--line)] bg-[var(--surface-elevated)] p-2 shadow-[0_8px_30px_rgba(15,23,42,0.04)] focus-within:border-[var(--brand)]/50">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask about today's POS sales…"
              disabled={isSending}
              className="max-h-[140px] min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[15px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isSending || !input.trim()}
              className="mb-0.5 rounded-xl bg-[var(--brand)] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-[var(--brand-strong)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-2 px-1 text-center text-[11px] text-[var(--muted)]">
            Enter to send · Shift+Enter for new line
          </p>
        </form>
      </main>
    </div>
  )
}
