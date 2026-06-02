import { stripSuggestionsFromText } from './suggestionsUtils'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

/**
 * @param {string | null | undefined} accessTokenOverride - Prefer React session access_token (avoids localStorage race / wrong key).
 */
function authHeaders(accessTokenOverride) {
  if (accessTokenOverride) {
    return { Authorization: `Bearer ${accessTokenOverride}` }
  }
  try {
    const edvise = localStorage.getItem('edvise_token')
    if (edvise) {
      try {
        const parsed = JSON.parse(edvise)
        if (parsed?.access_token) {
          return { Authorization: `Bearer ${parsed.access_token}` }
        }
      } catch {
        if (typeof edvise === 'string' && edvise.includes('.')) {
          return { Authorization: `Bearer ${edvise}` }
        }
      }
    }

    const url = import.meta.env.VITE_SUPABASE_URL || ''
    const ref = url.startsWith('http') ? new URL(url).hostname.split('.')[0] : ''
    const keys = [...new Set([
      ref ? `sb-${ref}-auth-token` : null,
      'sb-actkvdwxakexyldfqajw-auth-token',
    ].filter(Boolean))]

    let raw = null
    for (const k of keys) {
      raw = localStorage.getItem(k)
      if (raw) break
    }
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    const token = parsed?.access_token
    if (!token) return {}
    return { Authorization: `Bearer ${token}` }
  } catch {
    return {}
  }
}

// ── Analysis ────────────────────────────────────────────────────────────────

export async function uploadFile(file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${API_URL}/analysis/upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: formData,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function analyzeTextColumn(fileId, column) {
  const params = new URLSearchParams({ file_id: fileId, column })
  const res = await fetch(`${API_URL}/analysis/text?${params}`, {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function runAnalysis(
  fileId,
  mapping,
  stage,
  thresholds = null,
  filterTier = 'critical',
  gradeFilter = null,
  queryFilters = null,
  message = null,
) {
  const stageNorm =
    typeof stage === 'string'
      ? stage.trim().toLowerCase()
      : String(stage ?? '')
          .trim()
          .toLowerCase()
  const qf = queryFilters && typeof queryFilters === 'object' ? queryFilters : {}
  const res = await fetch(`${API_URL}/analysis/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      file_id: fileId,
      mapping,
      stage: stageNorm,
      thresholds,
      filter_tier: filterTier,
      ...(message ? { message } : {}),
      ...(gradeFilter != null && gradeFilter !== '' ? { grade_filter: String(gradeFilter) } : {}),
      ...(qf.require_ell ? { require_ell: true } : {}),
      ...(qf.demographic_subset ? { demographic_subset: qf.demographic_subset } : {}),
      ...(Array.isArray(qf.demographic_sort_roles) && qf.demographic_sort_roles.length
        ? { demographic_sort_roles: qf.demographic_sort_roles }
        : {}),
      ...(qf.min_suspension_count != null ? { min_suspension_count: qf.min_suspension_count } : {}),
      ...(qf.sort_by ? { sort_by: qf.sort_by } : {}),
      ...(qf.min_course_failures != null ? { min_course_failures: qf.min_course_failures } : {}),
      ...(qf.sel_cohort ? { sel_cohort: qf.sel_cohort } : {}),
      ...(qf.sel_cohort_grade ? { sel_cohort_grade: String(qf.sel_cohort_grade) } : {}),
      ...(qf.sel_baseline ? { sel_baseline: qf.sel_baseline } : {}),
      ...(Array.isArray(qf.sel_compare_grades) && qf.sel_compare_grades.length
        ? { sel_compare_grades: qf.sel_compare_grades }
        : {}),
      ...(qf.sel_compare_dimension ? { sel_compare_dimension: qf.sel_compare_dimension } : {}),
      ...(qf.sel_compare_grade ? { sel_compare_grade: String(qf.sel_compare_grade) } : {}),
      ...(qf.comparison_metric ? { comparison_metric: qf.comparison_metric } : {}),
      ...(qf.prior_list_context ? { prior_list_context: qf.prior_list_context } : {}),
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Knowledge: open approved KB PDF (auth required) ─────────────────────────

/**
 * Fetch PDF bytes and open in a new tab (blob URL). Closes blob after 2 minutes.
 * @param {string} documentId - kb_documents.id (UUID)
 */
export async function openKbPdfInNewTab(documentId, accessToken = null) {
  if (!documentId) return
  const res = await fetch(
    `${API_URL}/knowledge/documents/${encodeURIComponent(documentId)}/pdf`,
    { headers: authHeaders(accessToken) },
  )
  if (!res.ok) throw new Error(await res.text())
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener,noreferrer')
  setTimeout(() => URL.revokeObjectURL(url), 120000)
}

// ── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Stream a chat response from the backend.
 *
 * @param {object} params
 * @param {string} params.message          - The user's current message
 * @param {Array}  params.history          - Previous messages [{role, content}]
 * @param {object} params.data_context     - Analysis results to inject into context
 * @param {string} params.kb_scope         - CSV source tokens, e.g. "student_success,school,web" or "general"
 * @param {string|null} params.conversationId - Existing Supabase conversation UUID, or null for new thread
 * @param {function} params.onChunk        - Called for each streamed text chunk
 * @param {function} params.onSources      - Called when source documents are returned
 * @param {function} params.onConversationId - Called when server assigns/returns conversation_id
 * @param {function} params.onReplaceText - Called when backend sends full replacement text
 * @param {function} params.onViz - Called when backend sends viz JSON payload
 * @param {function} params.onSuggestions - Called when backend sends follow-up suggestion strings
 * @param {boolean} params.internal       - Internal orchestration prompt (do not persist as user message)
 */
export async function streamChat({
  message,
  history = [],
  data_context = null,
  kb_scope = 'global',
  conversationId = null,
  accessToken = null,
  internal = false,
  onChunk,
  onSources,
  onConversationId,
  onReplaceText,
  onViz,
  onSuggestions,
}) {
  const res = await fetch(`${API_URL}/chat/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({
      message,
      history,
      data_context,
      kb_scope,
      conversation_id: conversationId || null,
      internal,
    }),
  })

  if (!res.ok) throw new Error(await res.text())

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // Buffer lines: JSON payloads can be split across TCP chunks; splitting on \n per chunk drops events.
  let lineBuf = ''

  function handleSsePayload(payload) {
    if (payload === '[DONE]') return
    const data = JSON.parse(payload)
    if (data.text != null && onChunk) onChunk(data.text)
    if (Array.isArray(data.sources) && data.sources.length > 0 && onSources) onSources(data.sources)
    if (data.conversation_id && onConversationId) onConversationId(data.conversation_id)
    if (typeof data.replace_text === 'string') {
      const { text, suggestions } = stripSuggestionsFromText(data.replace_text)
      if (onReplaceText) onReplaceText(text)
      if (suggestions?.length && onSuggestions) onSuggestions(suggestions)
    }
    if (data.viz && onViz) onViz(data.viz)
    if (Array.isArray(data.suggestions) && data.suggestions.length > 0 && onSuggestions) {
      onSuggestions(data.suggestions)
    }
    if (data.error) throw new Error(data.error)
  }

  while (true) {
    const { done, value } = await reader.read()
    lineBuf += decoder.decode(value || new Uint8Array(), { stream: !done })

    let nl
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const raw = lineBuf.slice(0, nl)
      lineBuf = lineBuf.slice(nl + 1)
      const line = raw.replace(/\r$/, '').trim()
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      try {
        handleSsePayload(payload)
      } catch (e) {
        if (e instanceof SyntaxError) continue
        if (e.message && !e.message.includes('JSON')) throw e
      }
    }

    if (done) {
      const tail = lineBuf.replace(/\r$/, '').trim()
      if (tail.startsWith('data: ')) {
        try {
          handleSsePayload(tail.slice(6).trim())
        } catch (e) {
          if (!(e instanceof SyntaxError) && e.message && !e.message.includes('JSON')) throw e
        }
      }
      break
    }
  }
}

// ── Artifacts ─────────────────────────────────────────────────────────────────

export async function generateArtifact(
  type,
  context,
  conversationId = null,
  accessToken = null,
  { message = null, kb_scope = null } = {},
) {
  const res = await fetch(`${API_URL}/artifacts/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({
      artifact_type: type,
      context,
      conversation_id: conversationId,
      ...(message ? { message } : {}),
      ...(kb_scope ? { kb_scope } : {}),
    }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function saveArtifact(type, data, conversationId = null, accessToken = null, artifactId = null) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(accessToken) }
  if (import.meta.env.DEV) {
    console.log('saveArtifact:', type, 'Authorization:', headers.Authorization ? 'present' : 'missing')
  }
  const res = await fetch(`${API_URL}/artifacts/save`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      artifact_type: type,
      data,
      conversation_id: conversationId,
      ...(artifactId ? { id: artifactId } : {}),
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('Save error:', err)
    throw new Error(err)
  }
  return res.json()
}

export async function listArtifacts(type, accessToken = null) {
  const res = await fetch(`${API_URL}/artifacts/list/${encodeURIComponent(type)}`, {
    headers: { ...authHeaders(accessToken) },
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getArtifact(type, artifactId, accessToken = null) {
  const res = await fetch(
    `${API_URL}/artifacts/${encodeURIComponent(type)}/${encodeURIComponent(artifactId)}`,
    { headers: { ...authHeaders(accessToken) } },
  )
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Knowledge base ────────────────────────────────────────────────────────────

export async function uploadDocument(file, scope = 'school', schoolName = null, accessToken = null) {
  const formData = new FormData()
  formData.append('file', file)
  if (schoolName) formData.append('school_name', schoolName)
  // Only Authorization — do not set Content-Type; browser sets multipart boundary for FormData
  const headers = authHeaders(accessToken)
  const res = await fetch(`${API_URL}/knowledge/upload?scope=${encodeURIComponent(scope)}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('Upload error:', err)
    throw new Error(err || 'Upload failed')
  }
  return res.json()
}

export async function listDocuments(scope = null, accessToken = null) {
  const q = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  const res = await fetch(`${API_URL}/knowledge/documents${q}`, { headers: authHeaders(accessToken) })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/** Download an approved KB PDF (attachment). */
export async function downloadKbDocument(documentId, accessToken = null) {
  const res = await fetch(
    `${API_URL}/knowledge/documents/${encodeURIComponent(documentId)}/download`,
    { headers: authHeaders(accessToken) },
  )
  if (!res.ok) throw new Error(await res.text())
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  const m = cd.match(/filename="([^"]+)"/i) || cd.match(/filename=([^;\s]+)/i)
  const fallback = 'document.pdf'
  const filename = (m && m[1] ? m[1].replace(/"/g, '') : fallback) || fallback
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function approveKbDocument(docId, accessToken = null) {
  const res = await fetch(`${API_URL}/knowledge/documents/${encodeURIComponent(docId)}/approve`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function deleteKbDocument(docId, accessToken = null) {
  const res = await fetch(`${API_URL}/knowledge/documents/${encodeURIComponent(docId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

// ── Conversations ─────────────────────────────────────────────────────────────

export async function listConversations(accessToken = null) {
  const res = await fetch(`${API_URL}/chat/conversations`, {
    headers: authHeaders(accessToken),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function getConversationMessages(conversationId, accessToken = null) {
  const res = await fetch(`${API_URL}/chat/conversations/${conversationId}/messages`, {
    headers: authHeaders(accessToken),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/**
 * Persist follow-up suggestion pills on the latest assistant message (metadata.suggestions).
 */
export async function updateMessageSuggestions(conversationId, messageContent, suggestions, accessToken = null) {
  const res = await fetch(`${API_URL}/chat/conversations/${conversationId}/suggestions`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ message_content: messageContent, suggestions }),
  })
  if (!res.ok) return
  return res.json()
}

// ── Analysis state persistence ────────────────────────────────────────────────

/**
 * Save analysis state to conversation metadata.
 * Called after each stage completes so cards can be restored on conversation reload.
 */
export async function saveAnalysisState(conversationId, state, accessToken = null) {
  if (!conversationId) return
  const res = await fetch(`${API_URL}/chat/conversations/${conversationId}/analysis`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify(state),
  })
  if (!res.ok) return // non-fatal — don't throw
  return res.json()
}

/**
 * Get analysis state from conversation metadata.
 * Called when loading a conversation to restore analysis cards.
 */
export async function getAnalysisState(conversationId, accessToken = null) {
  if (!conversationId) return null
  const res = await fetch(`${API_URL}/chat/conversations/${conversationId}/analysis`, {
    headers: authHeaders(accessToken),
  })
  if (!res.ok) return null
  return res.json()
}

export async function runGroupComparison(fileId, mapping, message, metric, thresholds, accessToken = null) {
  return runAnalysis(
    fileId,
    mapping,
    'group_comparison',
    thresholds,
    null,    // filterTier
    null,    // gradeFilter
    { comparison_metric: metric },  // queryFilters
    message, // passed as message for resolve_custom_groups
  )
}

export async function confirmVariableNames(fileId, confirmedNames, accessToken = null) {
  const res = await fetch(`${API_URL}/analysis/confirm-names`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({
      file_id: fileId,
      confirmed_names: confirmedNames,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.detail || 'Failed to confirm variable names')
  }
  return res.json()
}

export async function classifyTeacherIntent(text, analysisStage = null, accessToken = null) {
  const res = await fetch(`${API_URL}/chat/classify-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(accessToken) },
    body: JSON.stringify({ text, analysis_stage: analysisStage }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}