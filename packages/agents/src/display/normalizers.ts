/**
 * Normalizers for poker data structures.
 * 
 * These handle conversion between the "human" (verbose) and "compact" (agent)
 * WebSocket message formats. Used by display formatters to unify handling
 * of different message formats.
 */

/**
 * Safely parse a JSON string. Returns null if parsing fails or input is not a string.
 */
export function safeParseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Normalize a card value that may be either a compact string ("Qs") or
 * a full Card object ({rank:"Q",suit:"s"}) into a Card object.
 */
export function normalizeCard(c: unknown): { rank: string; suit: string } {
  if (typeof c === 'string' && c.length >= 2)
    return { rank: c[0]!, suit: c[1]! }
  if (c && typeof c === 'object' && 'rank' in (c as Record<string, unknown>))
    return c as { rank: string; suit: string }
  return { rank: '?', suit: '?' }
}

/**
 * Normalize an array of cards from either compact or verbose format.
 */
export function normalizeCards(arr: unknown): Array<{ rank: string; suit: string }> {
  if (!Array.isArray(arr)) return []
  return arr.map(normalizeCard)
}

/**
 * Normalize legal actions from either human format ({kind, minAmount, maxAmount})
 * or compact format ({kind, min, max}) into a consistent shape.
 */
export function normalizeLegalActions(
  arr: unknown
): Array<{ kind: string; minAmount?: number; maxAmount?: number }> {
  if (!Array.isArray(arr)) return []
  return arr.map((a: Record<string, unknown>) => {
    const out: { kind: string; minAmount?: number; maxAmount?: number } = {
      kind: a.kind as string,
    }
    if (a.minAmount !== undefined) out.minAmount = a.minAmount as number
    else if (a.min !== undefined) out.minAmount = a.min as number
    if (a.maxAmount !== undefined) out.maxAmount = a.maxAmount as number
    else if (a.max !== undefined) out.maxAmount = a.max as number
    return out
  })
}
