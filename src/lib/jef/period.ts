export type DateRange = {
  label: string
  start: Date
  end: Date
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** Parse merchant phrases like "today", "this week", "this month". */
export function parsePeriod(q?: string): DateRange {
  const text = (q || 'today').toLowerCase()
  const now = new Date()

  if (/yesterday|کل/.test(text)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    return { label: 'yesterday', start: startOfDay(d), end: endOfDay(d) }
  }

  if (/this\s*week|اس\s*ہفتہ|اس\s*hafte/.test(text)) {
    const start = startOfDay(now)
    const day = start.getDay() || 7
    start.setDate(start.getDate() - (day - 1))
    return { label: 'this week', start, end: endOfDay(now) }
  }

  if (/last\s*week/.test(text)) {
    const end = startOfDay(now)
    const day = end.getDay() || 7
    end.setDate(end.getDate() - (day - 1))
    end.setMilliseconds(-1)
    const start = startOfDay(end)
    start.setDate(start.getDate() - 6)
    return { label: 'last week', start, end }
  }

  if (/last\s*month|پچھلا\s*مہینہ/.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    return { label: 'last month', start, end }
  }

  if (/this\s*month|اس\s*مہینہ|اس\s*mahina/.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    return { label: 'this month', start, end: endOfDay(now) }
  }

  // default: today
  return { label: 'today', start: startOfDay(now), end: endOfDay(now) }
}
