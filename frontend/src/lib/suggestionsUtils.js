/**
 * Strip SUGGESTIONS_JSON: [...] from assistant text (mirrors backend parser).
 */
function findSuggestionsMarkerIndex(text) {
  const m = text.match(/\*{0,2}SUGGESTIONS_JSON\*{0,2}\s*:/i)
  return m ? m.index : -1
}

function cleanTextBeforeMarker(text, idx) {
  return text.slice(0, idx).replace(/\*+$/, '').trim()
}

export function stripSuggestionsFromText(text) {
  if (!text || typeof text !== 'string') return { text: text || '', suggestions: null }

  const idx = findSuggestionsMarkerIndex(text)
  if (idx === -1) return { text, suggestions: null }

  const markerEnd = text.indexOf(':', idx) + 1

  const rest = text.slice(markerEnd).trim()
  const start = rest.indexOf('[')
  let suggestions = null

  if (start !== -1) {
    let depth = 0
    let end = -1
    for (let i = start; i < rest.length; i++) {
      const c = rest[i]
      if (c === '[') depth += 1
      else if (c === ']') {
        depth -= 1
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end !== -1) {
      try {
        const parsed = JSON.parse(rest.slice(start, end))
        if (Array.isArray(parsed)) {
          suggestions = parsed.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
        }
      } catch {
        suggestions = null
      }
    }
  }

  const clean = cleanTextBeforeMarker(text, idx)
  return { text: clean, suggestions: suggestions?.length ? suggestions : null }
}

/** Display text while streaming — hide content from SUGGESTIONS_JSON onward. */
export function visibleTextWhileStreaming(accumulated) {
  if (!accumulated) return ''
  const idx = findSuggestionsMarkerIndex(accumulated)
  if (idx === -1) return accumulated
  return cleanTextBeforeMarker(accumulated, idx)
}

/** Normalize pill label / click payload to a plain string. */
export function normalizeSuggestionText(raw) {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'object') {
    const fromObj = raw.text ?? raw.label ?? raw.question ?? raw.content ?? raw.prompt
    if (fromObj != null) return String(fromObj).trim()
  }
  return String(raw).trim()
}
