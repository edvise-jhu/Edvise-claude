import { useState, useRef, useEffect } from 'react'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import {
  streamChat,
  uploadFile,
  runAnalysis,
  getConversationMessages,
  generateArtifact,
  updateMessageSuggestions,
  saveAnalysisState,
  getAnalysisState,
} from '../../lib/api'
import { sanitizeStudentListAssistantText } from '../../lib/stripMarkdownTables'
import { pickThresholds as mergeThresholdPayload } from '../../lib/criteriaUtils'
import { stripSuggestionsFromText, visibleTextWhileStreaming, normalizeSuggestionText } from '../../lib/suggestionsUtils'
import {
  resolveSubgroupCompare,
  buildSchoolWideHighlights,
  buildCompareSubtitle,
  buildSubgroupSummaryPrompt,
} from '../../lib/subgroupCompare'

const ACTION_PLAN_TRIGGERS = [
  'action plan',
  '2-week plan',
  'two week plan',
  'implementation plan',
  'create a plan',
  'make a plan',
  'build a plan',
  'design a plan',
]
const AGENDA_TRIGGERS = [
  'meeting agenda',
  'generate agenda',
  'create agenda',
  'agenda for',
  'team meeting',
]
const REPORT_TRIGGERS = [
  'generate report',
  'create report',
  'summarize today',
  'summarise today',
  'make a report',
  'write a report',
]

const STUDENT_LIST_TRIGGERS = [
  'who are the highest-risk',
  'highest-risk students',
  'show me the students',
  'view highest-risk',
  'list of students',
  'show student list',
  'show me the full student list',
  'full student list',
  'all students',
  'which students',
]

/**
 * Triple-flag cohort + demographics / breakdown — subgroup analysis card (e.g. SPED/ELL tabs), not the student roster.
 * Inlined logic so detectStudentListTier can run before wantsTripleFlagCohortSubgroup mutual checks.
 */
function isTripleFlagCohortDemographicQuestion(text) {
  const lower = (text || '').toLowerCase()
  const triple =
    (/all\s*3|three\s*flags|triple|all\s*three|three\s*indicators/.test(lower) &&
      /flag|flags|risk|indicator/.test(lower)) ||
    /119\s*student/.test(lower)
  if (!triple) return false
  const demographic =
    /subgroup|subgroups|demographic|race|ethnicity|\bsped\b|\bell\b|\blep\b|\biep\b|special\s*ed|ses|break\s*down|breakdown|composition|share\s*of/.test(
      lower,
    )
  const explicitRoster =
    /show me the students|student list|pull a list|sortable table|list every student|full list of students/.test(
      lower,
    ) || /\bwhich students\b/.test(lower)
  return demographic && !explicitRoster
}

/** Readable labels for subgroup-picker rows when Claude metadata lacks a friendly name. Keys match common mapping shorthand / column stubs. */
const SUBGROUP_LABELS = {
  female: 'Gender (Female)',
  white: 'Race: White',
  black: 'Race: Black',
  asian: 'Race: Asian',
  hispanic: 'Race: Hispanic',
  other: 'Race: Other / Multiracial',
  speced: 'Special Education (IEP)',
  lep: 'Limited English Proficiency',
  ses: 'Low SES / Free-Reduced Lunch',
  ell: 'English Language Learner',
  overage: 'Overage for Grade',
}

function subgroupPickerGroupLabel(col, columnMetadata = {}) {
  const meta = columnMetadata[col]
  const fromMeta = meta?.label
  if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim()
  const lc = String(col || '').trim().toLowerCase()
  if (SUBGROUP_LABELS[col] != null) return SUBGROUP_LABELS[col]
  if (SUBGROUP_LABELS[lc] != null) return SUBGROUP_LABELS[lc]
  return String(col || '').replace(/_/g, ' ')
}

/** Natural-language: chronic/low attendance + course failure + suspension (all three). */
function wantsTripleFlagStudentList(text) {
  const lower = (text || '').toLowerCase()
  const hasFail =
    /fail|failing|failed/.test(lower) &&
    (/course|courses|math|english|class|classes|subject|subjects/.test(lower) ||
      /at\s*least\s*one|atleast\s*one|at\s*least|atleast|least\s*one|one\s+or\s+more/.test(lower))
  const hasSusp = /suspension|suspended|suspend/.test(lower)
  const hasLowAtt =
    /below\s*90|under\s*90|less\s*than\s*90|90\s*%|90%\s*attend|90\s*percent|attendance.*90/.test(lower) ||
    /attendance.*(below|under|less).*(90|nine)/.test(lower) ||
    /chronic|absent|absence|days?\s*missed|missed.*(day|school)/.test(lower)
  return Boolean(hasFail && hasSusp && hasLowAtt)
}

/** Build SEL API params from classifier filters only (no phrase regex). */
function buildSelQueryFromFilters(qf, stepGrade) {
  if (!qf || typeof qf !== 'object') return null
  if (qf.sel_compare_dimension && qf.sel_compare_grade) {
    return {
      sel_compare_dimension: qf.sel_compare_dimension,
      sel_compare_grade: String(qf.sel_compare_grade),
    }
  }
  if (Array.isArray(qf.sel_compare_grades) && qf.sel_compare_grades.length) {
    return { sel_compare_grades: qf.sel_compare_grades }
  }
  const grade = qf.sel_cohort_grade || stepGrade || null
  if (!qf.sel_cohort && !grade) return null
  const out = {}
  if (qf.sel_cohort) out.sel_cohort = qf.sel_cohort
  if (grade) out.sel_cohort_grade = String(grade)
  if (qf.sel_baseline) out.sel_baseline = qf.sel_baseline
  else if (grade) out.sel_baseline = 'grade'
  return out
}

function extractGradeFromText(text) {
  const lower = (text || '').toLowerCase()
  const gm = lower.match(
    /grade\s*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)\s*graders?|(\d{1,2})(?:st|nd|rd|th)\s*grade\b/,
  )
  return gm ? (gm[1] || gm[2] || gm[3]) : null
}

/** Grade + demographics + academic failure (who is driving the rate in that grade). */
function wantsGradeSubgroupDriverAnalysis(text) {
  const lower = (text || '').toLowerCase()
  if (!extractGradeFromText(text)) return false
  const subgroup =
    /subgroup|subgroups|demographic|race|ethnicity|sped|ell|ses|driving|disparit/.test(lower)
  const academic = /academic|failure|failing|fail/.test(lower)
  return subgroup && academic
}

/** Grade + suspensions + course failure: show overlap list (no dedicated card yet). */
function wantsSuspensionFailureOverlap(text) {
  const lower = (text || '').toLowerCase()
  const grade = extractGradeFromText(text)
  if (!grade) return null
  const hasSusp = /suspension|suspended|suspend/.test(lower)
  const hasFail = /academic|fail|failing|failure|courses?/.test(lower)
  const asksBreakdown = /break\s*down|breakdown|concentrat|cluster|among|already failing/.test(lower)
  if (!hasSusp || !hasFail || !asksBreakdown) return null
  // If explicitly asking "show/list students" we'll let detectStudentListTier handle it.
  if (/show me the students|student list|pull a list|sortable table/.test(lower)) return null
  return { grade }
}

function detectStudentListTier(text) {
  const lower = (text || '').toLowerCase()
  if (isGradeBreakdownRequest(text)) return null
  if (isTripleFlagCohortDemographicQuestion(text)) return null
  if (wantsGradeSubgroupDriverAnalysis(text)) return null
  if (/subgroup|subgroups/.test(lower) && !/show me the students|student list|pull a list|sortable table/.test(lower)) {
    return null
  }

  const grade = extractGradeFromText(text)

  // Detect intent
  let tier = null
  if (/all\s*3|three\s*flags|triple|all\s*three|three\s*indicators/.test(lower) && /flag|flags|risk|absence|susp|fail|indicator/.test(lower)) tier = 'triple'
  else if (/(on.?track|on track|not.?at.?risk|no.?flag|zero.?flag|doing.?well|performing.?well)/.test(lower)) tier = 'on_track'
  else if (/(high\s*risk|high-risk)/.test(lower) && !/(critical|highest)/.test(lower)) tier = 'high'
  else if (/(critical\s*tier|highest\s*risk|high-?risk|top\s*risk|most\s*urgent|most\s*at\s*risk|at\s*risk)/.test(lower)) tier = 'critical'
  else if (/(moderate|one\s*flag|single\s*flag)/.test(lower) && /student|risk|list/.test(lower)) tier = 'moderate'
  else if (
    /(academic|acadamic|failing|failure).*(only)/.test(lower) ||
    /(academic|acadamic)\s*only/.test(lower) ||
    (/outreach|priority\s*list/.test(lower) && /academic/.test(lower))
  ) {
    tier = 'academic_only'
  }
  else if (/(absence|absent|attendance).*(academic|acadamic|failing|failure)/.test(lower) || /(academic|acadamic|failing|failure).*(absence|absent|attendance)/.test(lower)) tier = 'absent_academic'
  else if (/(full|complete|entire).*(student\s*list|students)/.test(lower) || /(all\s*students|whole\s*list)/.test(lower)) tier = 'all'
  else if (STUDENT_LIST_TRIGGERS.some((t) => lower.includes(t))) tier = 'critical'
  // Grade-specific question with no explicit tier → default to critical for that grade
  else if (
    grade &&
    /student|risk|absent|fail|suspend|who|show|list/.test(lower) &&
    !/subgroup|subgroups|demographic/.test(lower)
  ) {
    tier = 'critical'
  }

  if (!tier) return null
  return { tier, grade }  // always return object so callers can extract grade
}

function extractVizFromText(text) {
  if (!text) return null
  const m = text.match(/```viz(?:\s+json)?\s*\n([\s\S]*?)\n```/i)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[1])
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function buildGradesFromSummary(gradeSummary, schoolTotal = 0) {
  if (!gradeSummary || typeof gradeSummary !== 'object') return []
  return Object.entries(gradeSummary).map(([label, g]) => {
    const gradeTotal = Number(g.total || 0)
    const allThreeN = Number(g.all_three_count || 0)
    return {
      label: `Grade ${label}`,
      n: gradeTotal,
      flagged_pct: Number(g.two_plus_pct || 0),
      indicators: [
        { name: 'Academic failure', count: Number(g.failing_count || 0), pct: Number(g.failing_pct || 0) },
        { name: 'Chronic absence', count: Number(g.absent_count || 0), pct: Number(g.absent_pct || 0) },
        { name: 'Suspensions', count: Number(g.suspended_count || 0), pct: Number(g.suspended_pct || 0) },
        {
          name: 'All 3 flags',
          count: allThreeN,
          pct: gradeTotal > 0 ? Math.round((allThreeN / gradeTotal) * 100) : 0,
        },
      ],
    }
  })
}

function isGradeBreakdownRequest(text) {
  const lower = (text || '').toLowerCase()
  return lower.includes('grade breakdown') || lower.includes('view grade breakdown')
}

function buildGradeComparisonViz(gradeSummary) {
  const grades = buildGradesFromSummary(gradeSummary)
  if (!grades.length) return null
  return {
    type: 'grade_comparison',
    title: 'Grade breakdown',
    grades,
    insights: [],
    next_actions: [
      'Run subgroup analysis →',
      'Show me students with all 3 flags',
      'Run well-being analysis',
    ],
  }
}

function toUnifiedViz(risk) {
  if (!risk || typeof risk !== 'object') return null
  const total = Number(risk.total || 0)
  const indicatorsObj = risk.indicators || {}
  const indicatorList = [
    { name: 'Academic failure', key: 'academic', color: '#D85A30' },
    { name: 'Chronic absence', key: 'attendance', color: '#378ADD' },
    { name: 'Suspensions', key: 'behavior', color: '#BA7517' },
  ].map(({ name, key, color }) => {
    const src = indicatorsObj[key] || {}
    const count = Number(src.count || 0)
    return {
      name,
      count,
      pct_of_total: total > 0 ? Number(((count / total) * 100).toFixed(1)) : 0,
      color,
    }
  })
  const totalFlagged = Number(risk?.overlap?.two_or_more?.count || 0)
  const grades = buildGradesFromSummary(risk.grade_summary || {}, total)

  const top = [...indicatorList].sort((a, b) => b.pct_of_total - a.pct_of_total)[0]
  return {
    type: 'unified_analysis',
    title: `School overview — ${total} students`,
    summary: {
      total_students: total,
      total_flagged: totalFlagged,
      flagged_pct: total > 0 ? Number(((totalFlagged / total) * 100).toFixed(1)) : 0,
      highlight_metric: top ? `${top.name} is the largest indicator at ${top.pct_of_total}%` : '',
    },
    indicators: indicatorList,
    overlap: risk?.overlap
      ? {
          two_or_more: {
            count: Number(risk.overlap.two_or_more?.count || 0),
            pct: Number(risk.overlap.two_or_more?.pct || 0),
          },
          all_three: {
            count: Number(risk.overlap.all_three?.count || 0),
            pct: Number(risk.overlap.all_three?.pct || 0),
          },
          combinations: risk.overlap.combinations || {},
        }
      : {
          two_or_more: { count: 0, pct: 0 },
          all_three: { count: 0, pct: 0 },
          combinations: {},
        },
    grade_summary: risk.grade_summary || {},
    thresholds_used: risk.thresholds_used || null,
    grades,
    next_actions: [
      'Run subgroup analysis →',
      'Run well-being analysis',
      'Show me students with all 3 flags',
    ],
  }
}

function toSubgroupViz(result, intentStep = null) {
  if (!result || typeof result !== 'object') return null
  const compare_metrics = resolveSubgroupCompare(intentStep)
  const school_wide_highlights = buildSchoolWideHighlights(result.categories, compare_metrics)
  const compare_subtitle =
    (intentStep?.compare_subtitle && String(intentStep.compare_subtitle).trim()) ||
    buildCompareSubtitle(compare_metrics)
  return {
    type: 'subgroup_breakdown',
    mode: result.mode || 'school_wide',
    total: result.total,
    cohort_total: result.cohort_total ?? null,
    grade: result.grade ?? null,
    grade_total: result.grade_total ?? null,
    categories: result.categories,
    compare_metrics,
    compare_subtitle,
    school_wide_highlights,
  }
}

/** Full-school subgroup equity (all enrolled students). */
function wantsFullSubgroupAnalysis(text) {
  const lower = (text || '').toLowerCase()
  if (wantsTripleFlagCohortSubgroup(text)) return false
  return (
    /full\s*subgroup/.test(lower) ||
    (/subgroup\s*analysis/.test(lower) && /all\s*\d|4,?651|entire|whole\s*school|every\s*student/.test(lower)) ||
    (/not\s*just\s*the\s*triple|not\s*only\s*the\s*triple/.test(lower) && /subgroup|demographic/.test(lower)) ||
    (lower.includes('run subgroup') && !lower.includes('triple-flag') && !/119\s*student/.test(lower))
  )
}

/** Breakdown of the all-3-flags cohort by demographic (% of that cohort). */
function wantsTripleFlagCohortSubgroup(text) {
  const lower = (text || '').toLowerCase()
  if (wantsFullSubgroupAnalysis(text)) return false
  const triple =
    (/all\s*3|three\s*flags|triple|all\s*three|three\s*indicators/.test(lower) &&
      /flag|flags|risk|indicator/.test(lower)) ||
    /119\s*student/.test(lower)
  const subgroup =
    /subgroup|demographic|race|ethnicity|sped|ell|ses|break\s*down|breakdown|who is most affected/.test(lower)
  const studentList =
    /show me the students|student list|which students|pull a list|sortable table/.test(lower)
  return triple && subgroup && !studentList
}

/** Local fallback when classify-intent fails — mirrors backend _fallback_analysis_type. */
function inferAnalysisTypeFromText(text, stage) {
  if (isGradeBreakdownRequest(text)) return 'grade_breakdown'
  if (wantsGradeSubgroupDriverAnalysis(text)) return 'subgroup_grade_driver'
  if (wantsTripleFlagCohortSubgroup(text)) return 'subgroup_triple_cohort'
  if (wantsFullSubgroupAnalysis(text)) return 'subgroup_school_wide'
  const lower = (text || '').toLowerCase()
  if (
    (stage === 'unified' || !stage) &&
    (/subgroup|demographic/.test(lower) || (lower.includes('breakdown') && !lower.includes('grade')))
  ) {
    return 'subgroup_picker'
  }
  return null
}

const FILE_SESSION_STORAGE_KEY = 'edvise_file_session'

/** Appended to internal analysis summary prompts so pills match teacher-facing chat. */
const SUGGESTIONS_PROMPT_SUFFIX = `
After your summary, add a blank line, then exactly one final line (no code fences, nothing after it):
SUGGESTIONS_JSON: ["follow-up 1", "follow-up 2", "follow-up 3"]
Use 3 short, specific questions grounded in CURRENT ANALYSIS DATA (real grades, counts, %). Do not mention Stage 1/2/3 or "intersection analysis" — offer subgroup analysis, well-being analysis, or student lists instead.`

function isStreamingAssistantSlot(msg) {
  if (!msg || msg.role !== 'assistant') return false
  const id = msg.id
  if (id === '__loading_students__') return true
  if (typeof id === 'string' && id.startsWith('stream-')) return true
  return false
}

function patchAssistantById(prev, streamMessageId, patch) {
  if (!streamMessageId) return prev
  const updated = [...prev]
  for (let i = updated.length - 1; i >= 0; i--) {
    if (updated[i].role === 'assistant' && updated[i].id === streamMessageId) {
      updated[i] = { ...updated[i], ...patch }
      return updated
    }
  }
  return prev
}

function finalizeAssistantMessage(setMessages, fullText, suggestions, streamMessageId = null) {
  const stripped = stripSuggestionsFromText(fullText || '')
  const text = stripped.text
  const pills = suggestions?.length ? suggestions : stripped.suggestions
  setMessages((prev) => {
    const updated = [...prev]
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].role !== 'assistant') continue
      if (streamMessageId) {
        if (updated[i].id !== streamMessageId) continue
      } else if (!isStreamingAssistantSlot(updated[i])) {
        // Never wipe a completed assistant reply (e.g. summary + suggestion pills above)
        continue
      }
      updated[i] = {
        ...updated[i],
        content: text,
        ...(pills?.length ? { suggestions: pills, primarySuggestion: true } : {}),
      }
      break
    }
    return updated
  })
  return { text, suggestions: pills }
}
const ACTIVE_CONV_STORAGE_KEY = 'edvise_active_conversation_id'

function persistActiveConversationId(id) {
  if (!id) return
  try { sessionStorage.setItem(ACTIVE_CONV_STORAGE_KEY, id) } catch { /* ignore */ }
}

function parseThresholdUpdateFromText(text) {
  if (!text) return null
  const marker = 'THRESHOLD_UPDATE_JSON:'
  const idx = text.indexOf(marker)
  if (idx !== -1) {
    const rest = text.slice(idx + marker.length).trim()
    const start = rest.indexOf('{')
    if (start === -1) return null
    let depth = 0, end = -1
    for (let i = start; i < rest.length; i++) {
      if (rest[i] === '{') depth++
      if (rest[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end === -1) return null
    try { return mergeThresholdPayload(JSON.parse(rest.slice(start, end))) } catch { return null }
  }
  if (/I'll update the threshold/i.test(text) || /I(?:'|')?ll update the threshold/i.test(text)) {
    const jsonMatch = text.match(/\{[\s\S]*?"chronic_absence_threshold"[\s\S]*?\}/)
    if (jsonMatch) { try { return mergeThresholdPayload(JSON.parse(jsonMatch[0])) } catch { return null } }
  }
  return null
}

export default function Chat({
  accessToken = null,
  analysisContext,
  onAnalysisReady,
  onToggleSidebar,
  onOpenArtifacts,
  artifactOpen,
  onAddToReport,
  onAddToNotes,
  chatSessionKey = 0,
  openConversationId = null,
  onConversationHighlight,
  onConversationSaved,
  onArtifactGenerated,
  onConversationSnapshotChange,
}) {
  const [messages, setMessages] = useState([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isGeneratingArtifact, setIsGeneratingArtifact] = useState(false)
  const [analysisStage, setAnalysisStage] = useState(null)
  const [pendingFileData, setPendingFileData] = useState(null)
  const [csvPreviewOpen, setCsvPreviewOpen] = useState(false)
  const [contextFileData, setContextFileData] = useState(null)
  const fileDataRef = useRef(null)
  const fullMappingRef = useRef(null)  // preserves sel_factors/race_indicators that DataConfirmCard may filter out
  const uploadMetaRef = useRef(null)   // preview + columns from last upload (for criteria card)
  const pendingSuggestionsRef = useRef(null)
  const intentRef = useRef(null)  // 'foundational_analysis' | 'ask_data' | null
  const messageInputRef = useRef(null)
  const clarifyRoundRef = useRef(0)

  function getFileData() {
    let direct = fileDataRef.current || pendingFileData || (analysisContext?.file_id ? { file_id: analysisContext.file_id, mapping: analysisContext.mapping || {} } : null)
    try {
      const raw = sessionStorage.getItem(FILE_SESSION_STORAGE_KEY)
      if (raw) {
        const o = JSON.parse(raw)
        const cur = openConversationId || conversationIdRef.current || null
        // Only ignore session when we know the active conversation and it differs (not while cur is still null)
        if (o.conversationId != null && cur != null && o.conversationId !== cur) {
          /* conversation mismatch — ignore session */
        } else if (o?.file_id) {
          if (direct?.file_id && o.file_id === direct.file_id) {
            direct = {
              ...direct,
              ...(direct.filename == null && o.filename != null ? { filename: o.filename } : {}),
              ...(direct.rows == null && o.rows != null ? { rows: o.rows } : {}),
            }
          } else if (!direct?.file_id) {
            return {
              file_id: o.file_id,
              mapping: o.mapping || {},
              ...(o.filename != null ? { filename: o.filename } : {}),
              ...(o.rows != null ? { rows: o.rows } : {}),
            }
          }
        }
      }
    } catch { /* ignore */ }
    if (!direct?.file_id) return null
    return {
      file_id: direct.file_id,
      mapping: direct.mapping || {},
      ...(direct.filename != null ? { filename: direct.filename } : {}),
      ...(direct.rows != null ? { rows: direct.rows } : {}),
    }
  }

  useEffect(() => {
    const fd = getFileData()
    if (!fd?.file_id) {
      setContextFileData(null)
      return
    }
    // Only show file data if it matches the current conversation
    const currentConvId = conversationIdRef.current || openConversationId || null
    try {
      const raw = sessionStorage.getItem(FILE_SESSION_STORAGE_KEY)
      if (raw) {
        const o = JSON.parse(raw)
        if (o.conversationId && currentConvId && o.conversationId !== currentConvId) {
          setContextFileData(null)
          return
        }
      }
    } catch { /* ignore */ }
    setContextFileData(fd)
  }, [pendingFileData, analysisContext?.file_id, analysisContext?.mapping, openConversationId])

  function hasUploadedData() {
    return Boolean(getFileData()?.file_id || analysisContext?.file_id)
  }

  /** Restore file_id/mapping from conversation analysis state (fixes pills after reload). */
  async function ensureFileDataReady() {
    const existing = getFileData()
    if (existing?.file_id) return existing

    const convId = openConversationId || conversationIdRef.current
    if (!convId) return null

    try {
      const state = await getAnalysisState(convId, accessToken)
      if (state?.file_id && state?.mapping) {
        fileDataRef.current = {
          file_id: state.file_id,
          mapping: state.mapping,
          ...(state.filename && { filename: state.filename }),
          ...(state.rows && { rows: state.rows }),
        }
        setPendingFileData({
          file_id: state.file_id,
          mapping: state.mapping,
          ...(state.filename && { filename: state.filename }),
          ...(state.rows && { rows: state.rows }),
        })
        persistFileSession(state.file_id, state.mapping, {
          filename: state.filename,
          rows: state.rows,
        })
        if (state.stage) setAnalysisStage(state.stage)
        onAnalysisReady?.((prev) => ({
          ...(prev || {}),
          file_id: state.file_id,
          mapping: state.mapping,
          risk: state.risk ?? prev?.risk,
          thresholds: state.thresholds ?? prev?.thresholds,
          sel: state.sel ?? prev?.sel,
          subgroup: state.subgroup ?? prev?.subgroup,
        }))
        return getFileData()
      }
    } catch (e) {
      console.warn('[ensureFileDataReady]', e)
    }
    return getFileData()
  }

  function persistFileSession(fileId, mapping, fileMeta = null) {
    if (!fileId) return
    try {
      const cid = conversationIdRef.current || openConversationId || null
      const fullRef = fullMappingRef.current || {}
      const enrichedMapping = {
        ...mapping,
        ...(fullRef.sel_factors?.length && !mapping?.sel_factors?.length ? { sel_factors: fullRef.sel_factors } : {}),
        ...(fullRef.race_indicators?.length && !mapping?.race_indicators?.length ? { race_indicators: fullRef.race_indicators } : {}),
      }
      let prev = {}
      try {
        const existing = sessionStorage.getItem(FILE_SESSION_STORAGE_KEY)
        if (existing) prev = JSON.parse(existing)
      } catch { /* ignore */ }
      const payload = {
        file_id: fileId,
        mapping: enrichedMapping,
        conversationId: cid,
        ...(typeof fileMeta?.filename === 'string' ? { filename: fileMeta.filename } : prev.filename != null ? { filename: prev.filename } : {}),
        ...(typeof fileMeta?.rows === 'number' ? { rows: fileMeta.rows } : typeof prev.rows === 'number' ? { rows: prev.rows } : {}),
      }
      sessionStorage.setItem(FILE_SESSION_STORAGE_KEY, JSON.stringify(payload))
    } catch { /* ignore */ }
  }

  function attachConversationToFileSession(convId) {
    if (!convId) return
    try {
      const raw = sessionStorage.getItem(FILE_SESSION_STORAGE_KEY)
      if (!raw) return
      const o = JSON.parse(raw)
      if (!o.file_id) return
      sessionStorage.setItem(FILE_SESSION_STORAGE_KEY, JSON.stringify({ ...o, conversationId: convId }))
    } catch { /* ignore */ }
  }

  useEffect(() => {
    const fid = analysisContext?.file_id
    const mapping = analysisContext?.mapping
    if (!fid || !mapping || typeof mapping !== 'object') return
    fileDataRef.current = { file_id: fid, mapping }
    setPendingFileData((prev) => (prev?.file_id === fid ? prev : { file_id: fid, mapping }))
    persistFileSession(fid, mapping)
  }, [analysisContext?.file_id, analysisContext?.mapping, openConversationId])

  useEffect(() => {
    if (!onConversationSnapshotChange) return
    const snapshot = messages.filter((m) => ['user', 'assistant', 'card'].includes(m?.role)).map((m) => {
      if (m.role === 'card') return { role: 'card', type: m.type || 'card', title: m.title || null, data: m.data || null }
      return { role: m.role, content: m.content || '', sources: m.sources || [] }
    })
    onConversationSnapshotChange(snapshot)
  }, [messages, onConversationSnapshotChange])

  const historyRef = useRef([])
  const conversationIdRef = useRef(null)
  const prevChatSessionKeyRef = useRef(chatSessionKey)
  const prevOpenConversationIdRef = useRef(openConversationId)
  const actionInFlightRef = useRef(false)
  const lastKbScopeRef = useRef('student_success,general')
  const lastStudentListRef = useRef(null)
  const selVariablesConfirmedRef = useRef(false)

  // Restore SEL confirmation from sessionStorage on mount
  useEffect(() => {
    try {
      if (sessionStorage.getItem('edvise_sel_confirmed') === 'true') {
        selVariablesConfirmedRef.current = true
      }
    } catch { /* ignore */ }
  }, [])

  function threadRichness(msgs) {
    let score = 0
    for (const m of msgs || []) {
      if (m?.role === 'card') score += 4
      if (m?.viz) score += 4
      if (m?.suggestions?.length) score += 2
      if (String(m?.content || '').trim()) score += 1
    }
    return score
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!openConversationId) return
      const switchedConversation = prevOpenConversationIdRef.current !== openConversationId
      prevOpenConversationIdRef.current = openConversationId
      try {
        const rows = await getConversationMessages(openConversationId, accessToken)
        if (cancelled) return
        conversationIdRef.current = openConversationId
        persistActiveConversationId(openConversationId)
        if (switchedConversation) {
          setPendingFileData(null)
          fileDataRef.current = null
          setAnalysisStage(null)
        }
        try {
          const raw = sessionStorage.getItem(FILE_SESSION_STORAGE_KEY)
          if (raw && openConversationId) {
            const o = JSON.parse(raw)
            if (o.file_id && o.conversationId === openConversationId) {
              fileDataRef.current = {
                file_id: o.file_id,
                mapping: o.mapping || {},
                ...(o.filename != null ? { filename: o.filename } : {}),
                ...(o.rows != null ? { rows: o.rows } : {}),
              }
              setPendingFileData({
                file_id: o.file_id,
                mapping: o.mapping || {},
                ...(o.filename != null ? { filename: o.filename } : {}),
                ...(o.rows != null ? { rows: o.rows } : {}),
              })
            }
          }
        } catch { /* ignore */ }
        const msgs = [], hist = []
        for (const row of rows) {
          if (row.role === 'user' || row.role === 'assistant') {
            const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
            const stripped = stripSuggestionsFromText(row.content || '')
            const savedSuggestions = Array.isArray(meta.suggestions) && meta.suggestions.length
              ? meta.suggestions
              : (stripped.suggestions || [])
            msgs.push({
              role: row.role,
              content: stripped.text,
              sources: meta.sources || [],
              suggestions: savedSuggestions,
              viz: meta.viz || null,
            })
            hist.push({ role: row.role, content: stripped.text })
          }
        }

        // Restore analysis cards from saved state
        try {
          const state = await getAnalysisState(openConversationId, accessToken)
          if (state?.file_id && state?.mapping) {
            // Restore file data so subsequent analysis calls work
            fileDataRef.current = {
              file_id: state.file_id,
              mapping: state.mapping,
              ...(state.filename && { filename: state.filename }),
              ...(state.rows && { rows: state.rows }),
            }
            setPendingFileData({
              file_id: state.file_id,
              mapping: state.mapping,
              ...(state.filename && { filename: state.filename }),
              ...(state.rows && { rows: state.rows }),
            })

            // Restore cards based on what stages were completed
            // Restore cards based on what stages were completed
            if (state.risk) {
              msgs.push({ role: 'card', type: 'risk_overview', data: state.risk, onAddToReport })
            }
            if (state.sel && state.sel.available !== false) {
              msgs.push({ role: 'card', type: 'sel_fallback', data: state.sel })
            }

            // Restore analysis stage so stage-advancement logic works
            if (state.stage) setAnalysisStage(state.stage)

            // Restore analysis context
            onAnalysisReady(prev => ({
              ...(prev || {}),
              risk: state.risk || prev?.risk,
              sel: state.sel || prev?.sel,
              subgroup: state.subgroup || prev?.subgroup,
              file_id: state.file_id,
              mapping: state.mapping,
              thresholds: state.thresholds || null,
            }))
          }
        } catch (e) {
          console.warn('Could not restore analysis state:', e)
        }

        setMessages((prev) => {
          if (actionInFlightRef.current) return prev
          if (switchedConversation) return msgs
          // DB reload must not replace a richer live thread (viz, cards, pills) with text-only rows
          if (prev.length > 0 && threadRichness(msgs) < threadRichness(prev)) return prev
          return msgs
        })
        historyRef.current = hist
      } catch (e) { console.error('Failed to load conversation', e) }
    }
    run()
    return () => { cancelled = true }
  }, [openConversationId, accessToken])

  useEffect(() => {
    if (openConversationId) { prevChatSessionKeyRef.current = chatSessionKey; return }
    const prev = prevChatSessionKeyRef.current
    if (chatSessionKey !== prev) {
      prevChatSessionKeyRef.current = chatSessionKey
      if (chatSessionKey > 0) {
        setMessages([])
        historyRef.current = []
        conversationIdRef.current = null
        setPendingFileData(null)
        fileDataRef.current = null
        setContextFileData(null)
        setCsvPreviewOpen(false)
        setAnalysisStage(null)
        try { sessionStorage.removeItem(FILE_SESSION_STORAGE_KEY) } catch { /* ignore */ }
        try { sessionStorage.removeItem('edvise_column_metadata') } catch { /* ignore */ }
        try { sessionStorage.removeItem('edvise_sel_confirmed') } catch { /* ignore */ }
        selVariablesConfirmedRef.current = false
      }
    }
  }, [openConversationId, chatSessionKey])

  useEffect(() => {
    if (openConversationId || !accessToken) return
    if (conversationIdRef.current) return
    const savedId = (() => { try { return sessionStorage.getItem(ACTIVE_CONV_STORAGE_KEY) } catch { return null } })()
    if (!savedId) return
    let cancelled = false
    ;(async () => {
      try {
        const rows = await getConversationMessages(savedId, accessToken)
        if (cancelled) return
        const msgs = [], hist = []
        for (const row of rows) {
          if (row.role === 'user' || row.role === 'assistant') {
            const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
            msgs.push({ role: row.role, content: row.content || '', sources: [], viz: meta.viz || null })
            hist.push({ role: row.role, content: row.content || '' })
          }
        }
        setMessages((current) => {
          if (current.length > 0) return current
          conversationIdRef.current = savedId
          historyRef.current = hist
          return msgs
        })
      } catch (e) { console.error('Failed to restore conversation', e) }
    })()
    return () => { cancelled = true }
  }, [openConversationId, accessToken])

  function pushHistory(role, content) {
    if (content && content.trim()) historyRef.current = [...historyRef.current, { role, content }]
  }

  function thresholdsArg() {
    const t = analysisContext?.thresholds
    return t && typeof t === 'object' ? t : null
  }

  async function handleViewHighestRiskStudents() {
    const fd = getFileData()
    if (!fd) return
    setIsAnalyzing(true)
    try {
      const res = await runAnalysis(fd.file_id, fd.mapping, 'students', thresholdsArg(), 'critical')
      onAnalysisReady((prev) => ({ ...(prev || {}), students: res, file_id: fd.file_id, mapping: fd.mapping }))
      const students = res.students || []
      setMessages((prev) => [...prev, { role: 'card', type: 'student_table', data: { students, risk: analysisContext?.risk, mapping: fd.mapping, onTierChange: (nextTier) => handleShowStudentList(nextTier), studentsMeta: { total: res.total, shown: res.shown, truncated: res.truncated, by_grade: res.by_grade, tier_filter: res.tier_filter, chronic_absent_count: res.chronic_absent_count, severe_absent_count: res.severe_absent_count } } }])
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Could not load students: ${e.message}`, sources: [] }])
    } finally { setIsAnalyzing(false) }
  }

  async function handleShowStudentList(filterTier = 'critical', gradeFilter = null, queryFilters = null, sourceText = null, listContext = null) {
    await ensureFileDataReady()
    const fd = getFileData()
    if (!fd?.file_id) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            'I need your uploaded data file to show the student list. Please upload your spreadsheet again (or reopen this conversation after your analysis has finished loading).',
          sources: [],
        },
      ])
      return
    }
    setIsAnalyzing(true)
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: '',
        sources: [],
        id: '__loading_students__',
        isLoading: true,
        loadingLabel: 'Loading student list…',
      },
    ])
    try {
      let qf = queryFilters || parseQueryFiltersFromText(sourceText || '')
      if (filterTier === 'academic_only' && !qf?.sort_by && fd.mapping?.failtot) {
        qf = { ...(qf || {}), sort_by: 'courses_failed' }
      }
      if (qf?.min_course_failures != null && !qf.sort_by && fd.mapping?.failtot) {
        qf = { ...qf, sort_by: 'courses_failed' }
      }
      const result = await runAnalysis(
        fd.file_id,
        fd.mapping,
        'students',
        thresholdsArg(),
        filterTier,
        gradeFilter,
        qf,
        sourceText || null,
      )
      onAnalysisReady((prev) => ({ ...(prev || {}), students: result, file_id: fd.file_id, mapping: fd.mapping }))
      const students = result.students || []

      const studentsMeta = {
        total: result.total,
        shown: students.length,
        truncated: result.truncated,
        by_grade: result.by_grade,
        tier_filter: result.tier_filter,
        chronic_absent_count: result.chronic_absent_count,
        severe_absent_count: result.severe_absent_count,
        filters_applied: result.filters_applied,
        sort_by: result.filters_applied?.sort_by || qf?.sort_by || null,
        list_title: listContext?.listTitle || result.list_title || result.filters_applied?.list_title || null,
      }

      // Store last student list context so classifier can inherit tier/grade on follow-up questions
      lastStudentListRef.current = {
        tier: filterTier,
        grade: gradeFilter,
        total: result.total,
        filters_applied: result.filters_applied,
      }

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== '__loading_students__'),
        {
          role: 'card',
          type: 'student_table',
          data: {
            students,
            risk: analysisContext?.risk,
            mapping: fd.mapping,
            onAddToReport,
            onTierChange: (nextTier) => handleShowStudentList(nextTier, gradeFilter, qf, sourceText),
            studentsMeta,
            initialGrade: gradeFilter,
            initialSort:
              studentsMeta.sort_by === 'courses_failed' && fd.mapping?.failtot
                ? { key: 'failtot', dir: 'desc' }
                : null,
          },
        },
      ])

      const gradeNote = gradeFilter ? ` in Grade ${gradeFilter}` : ''
      const isCountQuestion = /how many|count|would that be/i.test(sourceText || '')
      let summaryHint
      if (listContext?.narrativeHint) {
        summaryHint = `${listContext.narrativeHint} The table above has ${result.total} students${gradeNote}. Do not list student IDs or reproduce the table.`
      } else if (isCountQuestion) {
        summaryHint = `The UI already shows a student table for this filter. The exact match count is ${result.total} students${gradeNote}. Reply in 1-2 sentences stating that number clearly. Do not ask whether ELL or suspension columns exist. No markdown tables or student IDs.`
      } else if (result.filters_applied?.sort_by === 'courses_failed') {
        summaryHint = `The outreach priority table is already shown above (sorted by total courses failed)${gradeNote}. Write 2 sentences: confirm the count (${result.total}) and note the highest fail counts at the top. No markdown tables or student IDs.`
      } else {
        const prevTotal = lastStudentListRef.current?.total
        const prevContext = prevTotal && prevTotal !== result.total
          ? ` (${result.total} of the previous ${prevTotal} students match this filter)`
          : ''
        summaryHint = `The interactive student table has already been rendered above showing exactly ${result.total} students${gradeNote ? ` in Grade ${gradeFilter}` : ''}${prevContext}.
This is the correct filtered count — always use ${result.total}, never any other number from context.
Write 2-3 plain sentences only: state the count clearly${prevContext ? ' and how it relates to the previous group' : ''}, and the single most notable pattern in the data.
If the list is empty say so in one sentence. No bullet points, no tables, no student IDs, no markdown formatting.`
      }
      await appendAssistantStream(
        summaryHint,
        { students: { ...result, students, total: students.length }, file_id: fd.file_id, mapping: fd.mapping },
        { stripMarkdownTables: true },
      )
      return { result, studentsMeta, qf, mapping: fd.mapping }
    } catch (e) {
      setMessages((prev) => [...prev.filter((m) => m.id !== '__loading_students__'), { role: 'assistant', content: 'Could not load student list. Please make sure your data file is still uploaded.', sources: [] }])
      return null
    } finally { setIsAnalyzing(false) }
  }

  function mergeStepFilters(intent, step, text) {
    return {
      ...parseQueryFiltersFromText(text),
      ...(intent?.filters && typeof intent.filters === 'object' ? intent.filters : {}),
      ...(step?.filters && typeof step.filters === 'object' ? step.filters : {}),
    }
  }

  function selQueryFromStep(intent, step) {
    const qf = mergeStepFilters(intent, step, '')
    const stepGrade = step?.grade || intent?.grade || null
    return buildSelQueryFromFilters(qf, stepGrade)
  }

  async function runAnalysisOutput(step, intent, text) {
    const analysisType = step.analysis_type || intent.analysis_type ||
      (intent.confidence < 0.8 ? inferAnalysisTypeFromText(text, analysisStage) : null)
    const grade = step.grade || intent.grade || extractGradeFromText(text)
    switch (analysisType) {
      case 'unified':
      case 'risk_overview': {
        const risk = analysisContext?.risk
        if (risk) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: '', sources: [], viz: toUnifiedViz(risk), isAnalysisMessage: true },
          ])
          await appendAssistantStream(
            'The school overview is shown above. Confirm the key numbers (total students, flagged count, top indicator) in 1–2 sentences.',
            { risk },
            { attachToLastWithViz: true },
          )
        }
        return true
      }
      case 'grade_breakdown':
        await runGradeBreakdownFlow()
        return true
      case 'subgroup_school_wide':
        if (intent.answerable_from_context) {
          await appendAssistantStream(
            `The teacher asked: "${text}". ` +
            `Answer directly and concisely from the loaded subgroup data in context. ` +
            `Identify the top 2-3 subgroups with the highest rates for the metric asked. ` +
            `Compare each to the school-wide average. ` +
            `3 sentences maximum. Do not render a card or chart.`,
            analysisContext,
            { suppressViz: true },
          )
          return true
        }
        await runFullSubgroupAnalysis(text, step)
        return true
      case 'subgroup_triple_cohort':
        await runTripleFlagCohortSubgroup(text)
        return true
      case 'subgroup_grade_driver':
        await runGradeSubgroupDriverAnalysis(grade, text)
        return true
      case 'subgroup_picker':
        await runSubgroupStage()
        return true
      default:
        return false
    }
  }

  function messageIsSubgroupComparison(text) {
    const lower = (text || '').toLowerCase()
    const wantsRoster =
      STUDENT_LIST_TRIGGERS.some((t) => lower.includes(t)) ||
      /show me the students|sortable table|pull a list|student list|full roster/.test(lower)
    if (wantsRoster) return false
    const hasDemographic =
      /subgroup|subgroups|demographic|race|ethnicity|gender|\bsped\b|\bell\b|\blep\b|\biep\b|special\s*ed|low\s*ses|\bses\b/.test(
        lower,
      )
    const hasRateQuestion =
      /which\s+subgroup|highest\s+rates?|compare|comparison|academic\s+fail|course\s+fail|chronic\s+absen|multi[- ]?flag|overlap|2\+\s*flag|break\s*down\s+by|disparit/.test(
        lower,
      )
    return hasDemographic && hasRateQuestion
  }

  function coerceOutputsForSubgroupComparison(text, outputs) {
    if (!Array.isArray(outputs) || outputs.length === 0) return outputs
    if (!messageIsSubgroupComparison(text)) return outputs
    const kept = outputs.filter((o) => o?.type !== 'student_list')
    return kept.length ? kept : outputs
  }

  function coerceOutputsForPlanRequest(text, outputs) {
    if (!Array.isArray(outputs) || outputs.length === 0) return outputs
    const lower = (text || '').toLowerCase()
    const wantsPlan =
      ACTION_PLAN_TRIGGERS.some((t) => lower.includes(t)) ||
      (/\b(build|create|design|draft|make)\b/.test(lower) && /\b(plan|intervention)\b/.test(lower))
    if (!wantsPlan) return outputs
    const hasArtifact = outputs.some((o) => o?.type === 'artifact')
    const wantsRoster = STUDENT_LIST_TRIGGERS.some((t) => lower.includes(t)) ||
      /show me the students|sortable table|pull a list/.test(lower)
    if (hasArtifact) {
      const artifacts = outputs.filter((o) => o?.type === 'artifact')
      if (wantsRoster) {
        return outputs.filter((o) => o?.type === 'student_list' || o?.type === 'artifact')
      }
      return artifacts.length ? artifacts : outputs
    }
    const listStep = outputs.find((o) => o?.type === 'student_list')
    if (!listStep && outputs.length) return outputs
    return [{
      type: 'artifact',
      artifact_type: 'action_plan',
      ...(listStep?.grade && { grade: listStep.grade }),
      ...(listStep?.tier && { tier: listStep.tier }),
    }]
  }

  function coerceTripleFlagTier(text, tier) {
    const lower = (text || '').toLowerCase()
    const impliesTriple =
      /triple[- ]?flag|all\s*three|three\s*flags|three\s*indicators|all\s*3\s*flags/.test(lower)
    if (impliesTriple && (!tier || tier === 'critical' || tier === 'high')) return 'triple'
    return tier
  }

  function dedupeIntentOutputs(outputs) {
    if (!Array.isArray(outputs)) return []
    const out = []
    let selStep = null
    for (const step of outputs) {
      if (!step?.type) continue
      if (step.type === 'sel') {
        selStep = selStep
          ? {
              ...selStep,
              ...step,
              filters: { ...(selStep.filters || {}), ...(step.filters || {}) },
            }
          : step
        continue
      }
      out.push(step)
    }
    if (selStep) out.push(selStep)
    return out
  }

  async function executeIntentOutputs(intent, text, kbScope = 'general') {
    const outputs = dedupeIntentOutputs(
      coerceOutputsForSubgroupComparison(
        text,
        coerceOutputsForPlanRequest(text, intent?.outputs),
      ),
    )
    if (!Array.isArray(outputs) || outputs.length === 0) return false

    let lastListResult = null
    for (const step of outputs) {
      const type = step?.type
      if (type === 'student_list') {
        const qf = mergeStepFilters(intent, step, text)
        let tier = coerceTripleFlagTier(
          text,
          step.tier || intent.tier || (qf.min_course_failures != null ? 'all' : 'critical'),
        )
        if (filterTierFixesAcademicOnly(tier, qf, text)) tier = 'all'
        const grade = step.grade || intent.grade || extractGradeFromText(text)
        if (!qf.sort_by && fdHasFailtot() && (qf.min_course_failures != null || tier === 'academic_only')) {
          qf.sort_by = 'courses_failed'
        }
        lastListResult = await handleShowStudentList(tier, grade, qf, text, {
          listTitle: step.list_title,
          narrativeHint: step.narrative_hint,
        })
      } else if (type === 'sel') {
        const qf = selQueryFromStep(intent, step) || {}
        // Inherit grade and demographic from sibling student_list step if not already set
        const siblingList = outputs.find(o => o?.type === 'student_list')
        if (siblingList?.grade && !qf.sel_cohort_grade) qf.sel_cohort_grade = siblingList.grade
        if (siblingList?.filters?.demographic_subset && !qf.sel_compare_dimension) {
          qf.sel_compare_dimension = siblingList.filters.demographic_subset
          if (siblingList.grade) qf.sel_compare_grade = siblingList.grade
        }
        await runSELStage({ queryFilters: Object.keys(qf).length ? qf : null, sourceText: text })
      } else if (type === 'group_comparison') {
        try {
          await runCustomGroupComparison(text, step.metric || 'indicators', lastStudentListRef.current)
        } catch (e) {
          await appendAssistantStream(
            `The teacher asked: "${text}"\n\n` +
            `INSTRUCTION: The exact computation wasn't possible. ` +
            `Answer in 2 sentences using whatever is available in CURRENT ANALYSIS DATA. ` +
            `Then in one sentence tell the teacher what to ask to get the precise answer.`,
            analysisContext,
            { suppressViz: true },
          )
        }
      } else if (type === 'analysis') {
        await runAnalysisOutput(step, intent, text)
      } else if (type === 'artifact') {
        await streamResearchForArtifact(text, kbScope)
        await handleGenerateArtifact(step.artifact_type || 'action_plan', {
          focus: text,
          fromSuggestion: true,
          plan_variant: step.plan_variant,
          student_list: lastListResult?.result,
          kbScope,
        })
      }
    }
    return true
  }

  function fdHasFailtot() {
    const m = getFileData()?.mapping || fullMappingRef.current
    return Boolean(m?.failtot)
  }

  function filterTierFixesAcademicOnly(tier, qf, text) {
    return (
      qf.min_course_failures != null &&
      tier === 'academic_only' &&
      !/academic[\s-]?only/i.test(text || '')
    )
  }

  async function applyThresholdsAndRerun(newPartial) {
    const fd = getFileData()
    if (!fd) return
    const { file_id, mapping } = fd
    let merged = null
    onAnalysisReady((prev) => {
      merged = { ...(prev?.thresholds || {}), ...newPartial }
      const next = { ...(prev || {}), thresholds: merged, file_id, mapping }
      delete next.students
      return next
    })
    if (!merged) return
    setIsAnalyzing(true)
    try {
      const risk = await runAnalysis(file_id, mapping, 'unified', merged)
      onAnalysisReady((prev) => { const next = { ...(prev || {}), risk, thresholds: merged, file_id, mapping }; delete next.students; return next })
      setMessages(prev => [
        ...prev.filter(m => m.type !== 'risk_overview' && m.type !== 'grade_comparison'),
        { role: 'assistant', content: 'I\'ve recalculated risk indicators using your updated thresholds.', sources: [] },
        { role: 'card', type: 'risk_overview', data: risk, onAddToReport },
      ])

      // Rerun every analysis type that was previously computed and lives in analysisContext.
      // Each entry maps a context key to the stage name the backend expects.
      const rerunStages = Object.entries({
        subgroup: 'subgroup',
        sel: 'sel',
      }).filter(([ctxKey]) => {
        const val = analysisContext?.[ctxKey]
        return val && val.available !== false
      })

      for (const [ctxKey, stage] of rerunStages) {
        try {
          const result = await runAnalysis(file_id, mapping, stage, merged)
          onAnalysisReady(prev => ({ ...prev, [ctxKey]: result }))
        } catch (e) {
          console.warn(`[applyThresholdsAndRerun] ${stage} rerun failed:`, e)
        }
      }

      if (conversationIdRef.current) {
        const updatedCtx = {}
        for (const [ctxKey] of rerunStages) {
          if (analysisContext?.[ctxKey]) updatedCtx[ctxKey] = analysisContext[ctxKey]
        }
        void saveAnalysisState(conversationIdRef.current, {
          thresholds: merged,
          risk,
          ...updatedCtx,
        }, accessToken).catch(() => {})
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Could not re-run analysis: ${e.message}`, sources: [] }])
    } finally { setIsAnalyzing(false) }
  }

  async function maybeApplyThresholdFromAssistant(fullResponse) {
    const upd = parseThresholdUpdateFromText(fullResponse)
    if (upd) await applyThresholdsAndRerun(upd)
  }

  function normalizeArtifactOptions(opts) {
    if (opts == null) return {}
    if (typeof opts === 'string') return { focus: opts, fromSuggestion: false }
    return { ...opts, kbScope: opts.kbScope || opts.kb_scope || 'general' }
  }

  function buildArtifactGenerationContext(type, options = {}) {
    const norm = normalizeArtifactOptions(options)
    const { fromSuggestion = false, focus, plan_variant, student_list } = norm
    const ac = analysisContext || {}
    const r = ac.risk
    const flags = r?.flags
    const baseTrim = {
      ...(r && { total_students: r.total ?? r.total_students, critical: r.critical, high: r.high, moderate: r.moderate, on_track: r.on_track, chronic_absence: flags?.chronic_absence, academic_failures: flags?.academic_failures, suspensions: flags?.behavior, severe_absence: flags?.severe_absence, grade_breakdown: r.grade_breakdown, thresholds_used: r.thresholds_used ?? ac.thresholds, ...(r.grade_levels != null && { grade_levels: r.grade_levels }), ...(r.grade_levels == null && r.grade_breakdown && typeof r.grade_breakdown === 'object' && { grade_levels: Object.keys(r.grade_breakdown) }) }),
      ...(ac.intersection && { intersection: ac.intersection }),
      ...(ac.sel && ac.sel.available !== false && { sel: ac.sel }),
    }
    if (type === 'action_plan') {
      const focusStr = focus != null && String(focus).trim() !== '' ? String(focus).trim() : null
      const studentList = options.student_list
      return {
        ...baseTrim,
        ...(fromSuggestion && { artifact_chat_history: historyRef.current.slice(-30) }),
        ...(focusStr && { action_plan_focus: focusStr, focus_group: focusStr }),
        ...(plan_variant && { plan_variant }),
        ...(studentList && {
          student_list: {
            total: studentList.total,
            shown: studentList.shown,
            tier_filter: studentList.tier_filter,
            filters_applied: studentList.filters_applied,
            top_students: (studentList.students || []).slice(0, 25),
          },
        }),
      }
    }
    if (type === 'agenda' || type === 'report') {
      const userMsg = focus != null && String(focus).trim() !== '' ? String(focus).trim() : null
      return { ...baseTrim, ...(ac.thresholds && { thresholds: ac.thresholds }), ...(userMsg && { focus_group: userMsg, user_message: userMsg }) }
    }
    return ac
  }

  async function streamResearchForArtifact(text, kbScope = 'general') {
    const streamId = `stream-research-${Date.now()}`
    setIsStreaming(true)
    pendingSuggestionsRef.current = null
    setMessages((prev) => [...prev, { role: 'assistant', content: '', sources: [], id: streamId }])
    let fullResponse = ''
    let streamedSuggestions = null
    try {
      await streamChat({
        message: text,
        history: historyRef.current,
        data_context: analysisContext ?? null,
        kb_scope: kbScope,
        conversationId: conversationIdRef.current,
        accessToken,
        onChunk: (chunk) => {
          fullResponse += chunk
          const display = visibleTextWhileStreaming(fullResponse)
          setMessages((prev) => patchAssistantById(prev, streamId, { content: display }))
        },
        onSources: (sources) => {
          setMessages((prev) => patchAssistantById(prev, streamId, { sources }))
        },
        onConversationId: (id) => {
          conversationIdRef.current = id
          attachConversationToFileSession(id)
          persistActiveConversationId(id)
          onConversationHighlight?.(id)
          onConversationSaved?.()
        },
        onReplaceText: (nextText) => {
          const stripped = stripSuggestionsFromText(nextText || '')
          fullResponse = stripped.text
          if (stripped.suggestions?.length) streamedSuggestions = stripped.suggestions
          setMessages((prev) => patchAssistantById(prev, streamId, { content: fullResponse }))
        },
        onSuggestions: (suggestions) => {
          streamedSuggestions = suggestions
          pendingSuggestionsRef.current = suggestions
        },
      })
      const finalized = finalizeAssistantMessage(
        setMessages,
        fullResponse,
        streamedSuggestions || pendingSuggestionsRef.current,
        streamId,
      )
      fullResponse = finalized.text
      pushHistory('assistant', fullResponse)
    } catch (e) {
      console.warn('[streamResearchForArtifact]', e)
      setMessages((prev) =>
        patchAssistantById(prev, streamId, {
          content: 'I could not load research sources for this plan. I will still draft a plan from your data.',
        }),
      )
    } finally {
      setIsStreaming(false)
    }
  }

  async function handleGenerateArtifact(type, options = {}) {
    const norm = normalizeArtifactOptions(options)
    const kbScope = norm.kbScope || 'general'
    const focusText = norm.focus != null && String(norm.focus).trim() !== '' ? String(norm.focus).trim() : null
    const artifactContext = buildArtifactGenerationContext(type, norm)
    setIsGeneratingArtifact(true)
    onOpenArtifacts?.(type)
    onArtifactGenerated?.(type, null)
    setMessages((prev) => [...prev, { role: 'assistant', content: '', isLoading: true, sources: [] }])
    try {
      const result = await generateArtifact(type, artifactContext, conversationIdRef.current, accessToken, {
        message: focusText,
        kb_scope: kbScope,
      })
      if (!result || result.error) throw new Error(result?.error || 'Generation failed')
      const { sources: planSources, ...artifactData } = result
      onArtifactGenerated?.(type, artifactData)
      setMessages((prev) => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role !== 'assistant' || !last?.isLoading) return prev
        const done =
          type === 'action_plan' && norm.plan_variant === 'tutoring_tiers'
            ? 'Your tiered tutoring plan is ready in the panel on the right.'
            : type === 'action_plan'
              ? 'Your 2-week action plan is ready in the panel on the right.'
              : type === 'agenda'
                ? 'Your meeting agenda is ready in the panel on the right.'
                : 'Your report is ready in the panel on the right.'
        const suggestions = type === 'action_plan' || type === 'agenda' || type === 'report' ? ['Save to My Actions', 'Create a 2-week action plan', 'Brainstorm more interventions'] : undefined
        updated[updated.length - 1] = {
          ...last,
          content: done,
          isLoading: false,
          ...(planSources?.length ? { sources: planSources } : {}),
          ...(suggestions && { suggestions, isAnalysisMessage: true }),
        }
        return updated
      })
    } catch (e) {
      console.error('Artifact generation failed:', e)
      onArtifactGenerated?.(type, false)
      setMessages((prev) => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.isLoading) updated[updated.length - 1] = { ...last, content: 'Could not generate the artifact. Please try again.', isLoading: false, sources: [] }
        return updated
      })
    } finally { setIsGeneratingArtifact(false) }
  }

  function showActionPlanScaffold() {
    const r = analysisContext?.risk
    const f = r?.flags
    const options = r
      ? [`The triple-flag group (all three indicators — ${r?.overlap?.all_three?.count ?? r.critical ?? 0} students)`, `Chronically absent students broadly (${f?.chronic_absence ?? 0} students)`, `Students failing courses (${f?.academic_failures ?? 0} students)`, `Suspended students (${f?.behavior ?? 0} students)`, "Something else — I'll describe below"]
      : ['Chronically absent students', 'Students failing courses', 'Students with suspensions', 'All at-risk students', "Something else — I'll describe below"]
    setMessages((prev) => [...prev, { role: 'card', type: 'action_plan_scaffold', question: 'Which student group should this plan focus on?', options, onSelect: (selection) => { setMessages((p) => { const without = p.filter((m) => !(m.role === 'card' && m.type === 'action_plan_scaffold')); return [...without, { role: 'user', content: selection }] }); pushHistory('user', selection); void handleGenerateArtifact('action_plan', { focus: selection }) } }])
  }

  // ── File upload ──────────────────────────────────────────────────────────

  async function handleFileSelect(file) {
    // Reset intent so direct uploads always show the intent picker
    // (only starter card clicks should pre-set the intent)
    if (!intentRef._setByStarter) {
      intentRef.current = null
    }
    intentRef._setByStarter = false  // consume the flag

    // Show loader immediately — Claude mapping call can take 3-5 seconds
    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: '',
        isLoading: true,
        loadingLabel: `Reading ${file.name}…`,
        sources: [],
        id: '__file_uploading__',
      },
    ])

    try {
      const result = await uploadFile(file)
      setPendingFileData({ file_id: result.file_id, mapping: result.suggested_mapping })

      uploadMetaRef.current = {
        preview: result.preview || [],
        columns: result.columns || [],
        filename: result.filename,
        rows: result.rows,
      }

      // Store full mapping (including sel_factors, race_indicators) before DataConfirmCard filters it
      const fullMapping = result.suggested_mapping || {}
      fullMappingRef.current = fullMapping

      persistFileSession(result.file_id, fullMapping, { filename: result.filename, rows: result.rows })

      setMessages(prev => [
        ...prev.filter(m => m.id !== '__file_uploading__'),
        {
          role: 'assistant',
          content: "I've reviewed your dataset. Here's what I found — please confirm the variable mapping before I run the analysis:",
          sources: [],
        },
        {
          role: 'card',
          type: 'data_confirm',
          data: { ...result, intent: intentRef.current },
          onConfirm: (mapping, columnMetadata) => handleConfirm(result.file_id, mapping, columnMetadata || result.column_metadata || {}),
        },
      ])

      pushHistory('assistant', "I've reviewed your dataset. Here's the variable mapping — please confirm.")
    } catch (e) {
      const msg = `Could not read file: ${e.message}`
      setMessages(prev => [
        ...prev.filter(m => m.id !== '__file_uploading__'),
        { role: 'assistant', content: msg, sources: [] },
      ])
      pushHistory('assistant', msg)
    }
  }

  // ── After DataConfirmCard: run unified foundational analysis ─────────────

  async function handleConfirm(fid, confirmedMapping, columnMetadata = {}) {
    // Merge confirmed mapping with the full original mapping to restore
    // sel_factors, race_indicators etc that DataConfirmCard may have hidden
    const fullMapping = fullMappingRef.current || {}
    const mergedMapping = {
      ...fullMapping,        // start with everything Claude detected
      ...confirmedMapping,   // overlay teacher's confirmed choices (these win)
    }
    fileDataRef.current = { file_id: fid, mapping: mergedMapping }
    persistFileSession(fid, mergedMapping)

    // Store column metadata separately so it survives sessionStorage
    // (_column_metadata is stripped from mapping by backend filters)
    if (columnMetadata && Object.keys(columnMetadata).length > 0) {
      try {
        sessionStorage.setItem('edvise_column_metadata', JSON.stringify(columnMetadata))
      } catch { /* ignore */ }
    }

    const meta = uploadMetaRef.current || {}
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: 'Choose how to flag chronic absence, course failure, and suspensions — then I\'ll run your school overview.',
        sources: [],
      },
      {
        role: 'card',
        type: 'criteria_confirm',
        data: {
          mapping: mergedMapping,
          column_metadata: columnMetadata,
          preview: meta.preview || [],
          columns: meta.columns || [],
        },
        onConfirm: ({ thresholds }) => handleCriteriaConfirm(fid, mergedMapping, columnMetadata, thresholds),
      },
    ])
  }

  async function handleCriteriaConfirm(fid, mapping, columnMetadata, thresholds) {
    onAnalysisReady((prev) => ({
      ...(prev || {}),
      thresholds: thresholds || null,
      mapping,
      file_id: fid,
    }))
    await runFoundationalAnalysis(fid, mapping, columnMetadata)
  }

  function handleReopenCriteria() {
    const fd = getFileData()
    if (!fd) return
    const { file_id, mapping } = fd
    const meta = uploadMetaRef.current || {}
    let columnMetadata = {}
    try {
      const stored = sessionStorage.getItem('edvise_column_metadata')
      if (stored) columnMetadata = JSON.parse(stored)
    } catch { /* ignore */ }

    setMessages(prev => [
      ...prev,
      {
        role: 'assistant',
        content: 'Adjust your indicator criteria below — I\'ll rerun the analysis when you confirm.',
        sources: [],
      },
      {
        role: 'card',
        type: 'criteria_confirm',
        data: {
          mapping,
          column_metadata: columnMetadata,
          preview: meta.preview || [],
          columns: meta.columns || [],
          current_thresholds: analysisContext?.thresholds || null,
        },
        onConfirm: ({ thresholds }) => handleCriteriaConfirm(file_id, mapping, columnMetadata, thresholds),
      },
    ])
  }

  function handleRemoveFile() {
    fileDataRef.current = null
    setPendingFileData(null)
    setContextFileData(null)
    setCsvPreviewOpen(false)
    selVariablesConfirmedRef.current = false
    try { sessionStorage.removeItem(FILE_SESSION_STORAGE_KEY) } catch { /* ignore */ }
    try { sessionStorage.removeItem('edvise_column_metadata') } catch { /* ignore */ }
    try { sessionStorage.removeItem('edvise_sel_confirmed') } catch { /* ignore */ }
    onAnalysisReady(prev => ({
      ...(prev || {}),
      file_id: null,
      mapping: null,
      risk: null,
      subgroup: null,
      sel: null,
      students: null,
      thresholds: null,
    }))
    setMessages(prev => prev.filter(m =>
      m.type !== 'risk_overview' &&
      m.type !== 'grade_comparison' &&
      m.type !== 'student_table' &&
      m.type !== 'sel_fallback' &&
      m.type !== 'subgroup_picker' &&
      m.type !== 'criteria_confirm' &&
      m.type !== 'data_confirm' &&
      m.type !== 'variable_summary'
    ))
    if (conversationIdRef.current) {
      void saveAnalysisState(conversationIdRef.current, {
        file_id: null,
        mapping: null,
        stage: null,
        risk: null,
        sel: null,
        subgroup: null,
        thresholds: null,
      }, accessToken).catch(() => {})
    }
  }

  async function runFoundationalAnalysis(fid, mapping, columnMetadata = {}) {
    fileDataRef.current = { file_id: fid, mapping }
    persistFileSession(fid, mapping)

    const used = ['attendance', 'days_absent', 'behavior', 'math', 'english', 'failtot', 'grade']
      .filter((k) => mapping?.[k])
      .map((k) => `${k} -> ${mapping[k]}`)
      .join(', ')

    setMessages(prev => [
      ...prev,
      { role: 'assistant', content: `Running unified foundational analysis.\nUsing: ${used || 'mapped variables from your file.'}`, sources: [], id: '__analyzing__' },
    ])
    setIsAnalyzing(true)
    setAnalysisStage('unified')

    try {
      const risk = await runAnalysis(fid, mapping, 'unified', thresholdsArg())
      onAnalysisReady((prev) => { const next = { ...(prev || {}), risk, file_id: fid, mapping }; delete next.students; return next })

      setMessages(prev => [
        ...prev.filter(m => m.id !== '__analyzing__' && m.type !== 'risk_overview' && m.type !== 'grade_comparison'),
        { role: 'assistant', content: '', sources: [], viz: toUnifiedViz(risk) },
      ])

      await appendAssistantStream(
        'Summarize this unified foundational analysis in 2-3 sentences. Mention one urgent pattern and one positive signal. Do NOT output markdown tables; the UI already shows indicators and overlap. Do NOT ask about Stage 2 or intersection analysis.',
        { risk, thresholds: risk.thresholds_used ?? thresholdsArg() },
        { attachToLastWithViz: true },
      )

      // Auto-run subgroup analysis
      try {
        const subgroup = await runAnalysis(fid, mapping, 'subgroup', thresholdsArg())
        onAnalysisReady((prev) => ({ ...(prev || {}), subgroup, file_id: fid, mapping }))
        if (conversationIdRef.current) {
          void saveAnalysisState(conversationIdRef.current, {
            subgroup,
          }, accessToken).catch(() => {})
        }
      } catch (e) {
        console.warn('[runFoundationalAnalysis] subgroup failed:', e)
      }

      // Auto-run SEL after unified if SEL factors exist.
      if (Array.isArray(mapping.sel_factors) && mapping.sel_factors.length > 0) {
        try {
          const sel = await runAnalysis(fid, mapping, 'sel', thresholdsArg())
          onAnalysisReady((prev) => ({ ...(prev || {}), sel, file_id: fid, mapping }))
        } catch (e) {
          console.warn('[runFoundationalAnalysis] SEL failed:', e)
        }
      }

      setPendingFileData({ file_id: fid, mapping })

      // Persist analysis state so cards survive conversation reload
      if (conversationIdRef.current) {
        void saveAnalysisState(conversationIdRef.current, {
          file_id: fid,
          mapping,
          stage: 'unified',
          risk,
          thresholds: risk.thresholds_used ?? thresholdsArg() ?? null,
          filename: uploadMetaRef.current?.filename || null,
          rows: uploadMetaRef.current?.rows || null,
        }, accessToken).catch(() => {})
      }
    } catch (e) {
      setMessages(prev => [...prev.filter(m => m.id !== '__analyzing__'), { role: 'assistant', content: `Analysis failed: ${e.message}`, sources: [] }])
    } finally { setIsAnalyzing(false) }
  }

  // ── Subgroup demographic picker (no separate intersection stage) ─────────

  async function runSubgroupStage() {
    await ensureFileDataReady()
    const fd = getFileData()
    if (!fd) return
    const { file_id, mapping } = fd

    const subgroupCols = [
      mapping.gender,
      ...(Array.isArray(mapping.race_indicators) ? mapping.race_indicators : []),
      mapping.special_ed,
      mapping.ell,
      mapping.lep,
      mapping.low_ses,
    ].flat().filter(Boolean)

    if (subgroupCols.length === 0) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            'No demographic columns are mapped yet (gender, race/ethnicity flags, special education, ELL, LEP, or low SES). Upload mapping or confirm variables first, then try again.',
          sources: [],
        },
      ])
      return
    }

    const meta = mapping._column_metadata || {}

    setMessages((prev) => [
      ...prev,
      {
        role: 'card',
        type: 'subgroup_picker',
        data: {
          groups: subgroupCols.map((col) => ({
            key: col,
            label: subgroupPickerGroupLabel(col, meta),
            n: meta[col]?.n ?? null,
          })),
        },
        onConfirm: (selectedKeys) => {
          let patchedMapping = {
            ...mapping,
            race_indicators: (mapping.race_indicators || []).filter((c) => selectedKeys.includes(c)),
            gender: selectedKeys.includes(mapping.gender) ? mapping.gender : null,
            special_ed: selectedKeys.includes(mapping.special_ed) ? mapping.special_ed : null,
            ell: selectedKeys.includes(mapping.ell) ? mapping.ell : null,
            lep: selectedKeys.includes(mapping.lep) ? mapping.lep : null,
            low_ses: selectedKeys.includes(mapping.low_ses) ? mapping.low_ses : null,
          }
          if (fullMappingRef.current?.sel_factors?.length && !patchedMapping?.sel_factors?.length) {
            patchedMapping = { ...patchedMapping, sel_factors: fullMappingRef.current.sel_factors }
          }
          fileDataRef.current = { ...fd, file_id, mapping: patchedMapping }
          persistFileSession(file_id, patchedMapping)
          onAnalysisReady((prev) => {
            const next = { ...(prev || {}), mapping: patchedMapping, file_id }
            delete next.students
            return next
          })
          setPendingFileData({ file_id, mapping: patchedMapping })
          if (conversationIdRef.current) {
            void saveAnalysisState(
              conversationIdRef.current,
              { file_id, mapping: patchedMapping, stage: 'unified' },
              accessToken,
            ).catch(() => {})
          }
          void _doRunSubgroupAnalysis(file_id, patchedMapping)
        },
      },
    ])
  }

  async function runGradeSubgroupDriverAnalysis(grade, sourceText = '') {
    const fd = getFileData()
    if (!fd || !grade) return
    const { file_id, mapping } = fd

    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', sources: [], id: '__analyzing_grade_sg__' },
    ])
    setIsAnalyzing(true)

    try {
      const result = await runAnalysis(
        file_id,
        mapping,
        'grade_subgroup',
        thresholdsArg(),
        'critical',
        grade,
        null,
        sourceText,
      )
      onAnalysisReady((prev) => ({
        ...(prev || {}),
        grade_subgroup: result,
        file_id,
        mapping,
      }))

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== '__analyzing_grade_sg__'),
        { role: 'assistant', content: '', sources: [], viz: toSubgroupViz(result) },
      ])

      await appendAssistantStream(
        `Summarize which subgroups are driving academic failure in Grade ${grade}. Reference the highest academic-failure percentages by group from the card (SPED, ELL, race/ethnicity, SES as available). Do NOT output markdown tables or duplicate charts — the breakdown card is already shown.`,
        { grade_subgroup: result, risk: analysisContext?.risk },
        { attachToLastWithViz: true },
      )
    } catch (e) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== '__analyzing_grade_sg__'),
        {
          role: 'assistant',
          content: `Grade ${grade} subgroup analysis failed: ${e.message}`,
          sources: [],
        },
      ])
    } finally {
      setIsAnalyzing(false)
    }
  }

  async function runTripleFlagCohortSubgroup(sourceText = '') {
    const fd = getFileData()
    if (!fd) return
    const { file_id, mapping } = fd

    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', sources: [], id: '__analyzing_tf_sg__' },
    ])
    setIsAnalyzing(true)

    try {
      const result = await runAnalysis(file_id, mapping, 'triple_flag_subgroup', thresholdsArg(), null, null, null, sourceText)
      onAnalysisReady((prev) => ({
        ...(prev || {}),
        triple_flag_subgroup: result,
        file_id,
        mapping,
      }))

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== '__analyzing_tf_sg__'),
        { role: 'assistant', content: '', sources: [], viz: toSubgroupViz(result) },
      ])

      const n = result.cohort_total ?? 0
      await appendAssistantStream(
        `Summarize the triple-flag cohort breakdown in 2-3 sentences. There are ${n} students with all three indicators. Reference the largest shares as percent OF THAT COHORT (not percent of the whole school). Do NOT output markdown tables, bar charts, or student IDs — the breakdown card is already shown.`,
        { triple_flag_subgroup: result, risk: analysisContext?.risk },
        { attachToLastWithViz: true },
      )
    } catch (e) {
      setMessages((prev) => [
        ...prev.filter((m) => m.id !== '__analyzing_tf_sg__'),
        { role: 'assistant', content: `Cohort breakdown failed: ${e.message}`, sources: [] },
      ])
    } finally {
      setIsAnalyzing(false)
    }
  }

  async function runCustomGroupComparison(sourceText, metric = 'indicators', priorListContext = null) {
    const fd = getFileData()
    if (!fd) return
    const { file_id, mapping } = fd

    setMessages(prev => [
      ...prev,
      { role: 'assistant', content: '', sources: [], id: '__analyzing_groups__' },
    ])
    setIsAnalyzing(true)

    try {
      const result = await runAnalysis(
        file_id,
        mapping,
        'group_comparison',
        thresholdsArg(),
        null,
        null,
        { comparison_metric: metric, prior_list_context: priorListContext },
        sourceText,
      )

      if (!result?.available) {
        setMessages(prev => prev.filter(m => m.id !== '__analyzing_groups__'))
        throw new Error('no_groups')
      }

      onAnalysisReady(prev => ({ ...(prev || {}), group_comparison: result }))

      // Remove loading slot — Claude will stream the viz inline
      setMessages(prev => prev.filter(m => m.id !== '__analyzing_groups__'))

      const groupLabels = Object.values(result.groups || {}).map(g => g.label).join(', ')

      await appendAssistantStream(
        `The teacher asked: "${sourceText}"

Here is the computed group comparison data:
${JSON.stringify(result, null, 2)}

Instructions:
- Look at the actual values across groups for each metric.
- If metric is "indicators", compare absence, suspension, and failure rates across groups. Skip any metric where all groups show identical values.
- Output a 1-2 sentence summary of the most meaningful difference between groups.
- Then output a viz block. For indicators metric use a grouped bar chart. For single metrics use a horizontal bar chart.
- Use the group labels and actual values from the data above.
- Include school average baseline where relevant.
- Never write lead-in phrases before the viz block.
- Do not output a markdown table.`,
        { group_comparison: result },
        { attachToLastWithViz: false },
      )
    } catch (e) {
      setMessages(prev => prev.filter(m => m.id !== '__analyzing_groups__'))
      throw e
    } finally {
      setIsAnalyzing(false)
    }
  }

  async function runFullSubgroupAnalysis(questionText = '', intentStep = null) {
    const fd = getFileData()
    if (!fd) return
    await _doRunSubgroupAnalysis(fd.file_id, fd.mapping, questionText, intentStep)
  }

  async function _doRunSubgroupAnalysis(file_id, mapping, questionText = '', intentStep = null) {
    setMessages(prev => [
      ...prev.filter(m => m.role !== 'card' || m.type !== 'subgroup_picker'),
      { role: 'assistant', content: '', sources: [], id: '__analyzing_sg__' },
    ])
    setIsAnalyzing(true)

    try {
      const result = await runAnalysis(file_id, mapping, 'subgroup', thresholdsArg(), null, null, null, questionText)
      onAnalysisReady(prev => ({ ...(prev || {}), subgroup: result, file_id, mapping }))

      setMessages(prev => [
        ...prev.filter(m => m.id !== '__analyzing_sg__'),
        { role: 'assistant', content: '', sources: [], viz: toSubgroupViz(result, intentStep) },
      ])

      const compare_metrics = resolveSubgroupCompare(intentStep)
      const school_wide_highlights = buildSchoolWideHighlights(result.categories, compare_metrics)

      await appendAssistantStream(
        buildSubgroupSummaryPrompt(school_wide_highlights),
        {
          subgroup: {
            ...result,
            compare_metrics,
            school_wide_highlights,
          },
          risk: analysisContext?.risk,
        },
        { attachToLastWithViz: true },
      )

      setAnalysisStage('unified')

      // Persist subgroup results so they survive conversation reload
      if (conversationIdRef.current) {
        void saveAnalysisState(conversationIdRef.current, {
          stage: 'subgroup',
          subgroup: result,
        }, accessToken).catch(() => {})
      }
    } catch (e) {
      setMessages(prev => [
        ...prev.filter(m => m.id !== '__analyzing_sg__'),
        { role: 'assistant', content: `Analysis failed: ${e.message}`, sources: [] },
      ])
    } finally {
      setIsAnalyzing(false)
    }
  }

  async function runSELStage(opts = {}) {
    const selQuery = opts.queryFilters || null
    const sourceText = opts.sourceText || ''
    const fd = getFileData()
    if (!fd) return
    const { file_id } = fd

    // Always reconstruct mapping with sel_factors from fullMappingRef
    // because sel_factors may be lost through sessionStorage serialization or mapping merges
    const mapping = {
      ...fd.mapping,
      ...(fullMappingRef.current?.sel_factors && !fd.mapping?.sel_factors?.length
        ? { sel_factors: fullMappingRef.current.sel_factors }
        : {}),
      ...(fullMappingRef.current?.race_indicators && !fd.mapping?.race_indicators?.length
        ? { race_indicators: fullMappingRef.current.race_indicators }
        : {}),
    }

    // Check for SEL data before showing summary
    const selFactors = mapping.sel_factors || []
    if (selFactors.length === 0) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'There are no SEL survey columns in this dataset, so Stage 3 cannot run. If your school collects SEL survey data separately, you can upload a supplementary file at any time and I can run the SEL analysis then.',
        sources: [],
        suggestions: ['Brainstorm interventions', 'Create a 2-week action plan', 'Generate a meeting agenda'],
        isAnalysisMessage: true,
      }])
      return
    }

    if (
      selQuery?.sel_compare_grades?.length ||
      selQuery?.sel_cohort ||
      selQuery?.sel_cohort_grade
    ) {
      await _doRunSELStage(file_id, mapping, selQuery, sourceText)
      return
    }

    // Skip variable summary card if already confirmed this session
    if (selVariablesConfirmedRef.current) {
      await _doRunSELStage(file_id, mapping, null, sourceText)
      return
    }

    // Retrieve column metadata — may be stored separately in sessionStorage
    // since _column_metadata is stripped from mapping by backend filters
    let columnMetadata = mapping._column_metadata || {}
    try {
      const stored = sessionStorage.getItem('edvise_column_metadata')
      if (stored) {
        const parsed = JSON.parse(stored)
        columnMetadata = { ...parsed, ...columnMetadata }
      }
    } catch { /* ignore */ }

    function deriveSelLabel(col, metadata) {
      if (metadata?.[col]?.label) return metadata[col].label
      return col
        .replace(/^sel_?/i, '')
        .replace(/score$/i, '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim() || col
    }

    const selRows = selFactors.map(col => ({
      role: 'SEL Factor',
      col,
      label: deriveSelLabel(col, columnMetadata),
    }))

    setMessages((prev) => {
      const without = prev.filter((m) => !(m.role === 'card' && m.type === 'variable_summary'))
      return [
        ...without,
        {
          role: 'card',
          type: 'variable_summary',
          data: {
            variableRows: selRows,
            columnMetadata: columnMetadata,
            mapping,
            fid: file_id,
            intent: 'sel',
            hiddenDemoCount: 0,
            hiddenSelCount: 0,
            stageTitle: 'Stage 3 — SEL Factor Analysis variables',
            stageDesc: `${selFactors.length} social-emotional survey columns found. These will be compared across at-risk groups vs the class average.`,
          },
          onConfirmed: () => {
            selVariablesConfirmedRef.current = true
            try {
              sessionStorage.setItem('edvise_sel_confirmed', 'true')
            } catch { /* ignore */ }
            _doRunSELStage(file_id, mapping, null, sourceText)
          },
        },
      ]
    })
  }

  async function _doRunSELStage(file_id, mapping, selQuery = null, sourceText = '') {
    setIsAnalyzing(true)
    setAnalysisStage('sel')
    setMessages(prev => [
      ...prev.filter(m => !(m.role === 'card' && m.type === 'variable_summary')),
      { role: 'assistant', content: '', sources: [], id: '__analyzing3__' },
    ])
    try {
      const queryFilters = selQuery && typeof selQuery === 'object' ? selQuery : null
      const sel = await runAnalysis(file_id, mapping, 'sel', thresholdsArg(), 'critical', null, queryFilters, sourceText)
      onAnalysisReady((prev) => { const next = { ...(prev || {}), sel, file_id, mapping }; delete next.students; return next })
      setMessages(prev => [...prev.filter(m => m.id !== '__analyzing3__')])

      if (sel.available !== false) {
        setMessages((prev) => [...prev, { role: 'card', type: 'sel_fallback', data: sel }])
      }

      const selGroupLabels = sel.mode === 'custom_group_compare'
        ? Object.values(sel.groups || {}).map(g => g.label).join(', ')
        : null

      const selPrompt = sel.available === false
        ? 'The SEL analysis returned no SEL survey columns. Explain briefly and suggest next steps.'
        : sel.mode === 'demographic_compare'
          ? `The SEL chart compares ${sel.groups?.[`${sel.dimension}_yes`]?.label ?? 'the focal group'} vs ${sel.groups?.[`${sel.dimension}_no`]?.label ?? 'the comparison group'} in Grade ${sel.grade}. Flag rate for the focal group: ${sel.groups?.[`${sel.dimension}_yes`]?.flagged_pct ?? '?'}%. Write 3-4 sentences: whether SEL scores are lower for the focal group, which factors show the largest gap, and whether that pattern could relate to the flag rate mentioned. Do not compare whole grades or unrelated cohorts.`
          : sel.mode === 'grade_compare'
          ? `The SEL chart compares survey scores for Grade ${(sel.compare_grades || []).join(' vs Grade ')} against the school average. Write 2-4 sentences: confirm SEL data exists, note which factors differ most between these grades, and whether lower scores align with higher compounding risk in Grade ${sel.compare_grades?.slice(-1)[0] ?? '7'}. Do not discuss unrelated cohorts like chronically absent.`
          : sel.mode === 'custom_group_compare'
          ? `The SEL chart compares ${selGroupLabels} vs the school average (${sel.overall_label ?? 'school average'}). Write 2-3 sentences: if scores are very similar across groups (within 0.1–0.2 points), note that explicitly and suggest it may reflect when the survey was administered relative to when risk flags were assigned. If meaningful gaps exist (0.3+ points), highlight which factors differ most and what that implies for support. Do not reproduce the chart as a table.`
          : sel.mode === 'focused' || sel.focused
            ? `The SEL chart compares ${sel.focus_label ?? 'the focal cohort'} (n=${Object.values(sel.groups || {})[0]?.n ?? '?'}) to the ${sel.overall_label ?? 'baseline'}. Write 2-3 sentences: which factors show the largest gaps, what those gaps suggest about this group's experience of school, and one concrete implication for support. Do not reproduce the chart in a table.`
            : 'The SEL factor analysis results are already displayed in a chart above. Write only the cross-group narrative summary in teacher-friendly language — biggest gaps, what they mean, and one actionable observation per group. Do not generate any chart artifacts or repeat the numbers in table form.'
      await appendAssistantStream(selPrompt, { sel }, { attachToLastWithViz: false })

      // Persist SEL results
      if (conversationIdRef.current) {
        void saveAnalysisState(conversationIdRef.current, {
          stage: 'sel',
          sel,
        }, accessToken).catch(() => {})
      }
    } catch (e) {
      setMessages(prev => [...prev.filter(m => m.id !== '__analyzing3__'), { role: 'assistant', content: `SEL analysis failed: ${e.message}`, sources: [] }])
    } finally { setIsAnalyzing(false) }
  }

  // ── Stream a Claude response ─────────────────────────────────────────────

  async function appendAssistantStream(prompt, contextOverride = null, streamOpts = {}) {
    const {
      stripMarkdownTables = false,
      attachToLastWithViz = false,
      includeSuggestions = true,
      suppressViz = false,
    } = streamOpts
    const fullPrompt = includeSuggestions && !prompt.includes('SUGGESTIONS_JSON')
      ? `${prompt.trim()}\n${SUGGESTIONS_PROMPT_SUFFIX}`
      : prompt

    const streamId = `stream-${Date.now()}`
    setIsStreaming(true)
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (attachToLastWithViz && last?.role === 'assistant' && last.viz) {
        return [...prev.slice(0, -1), { ...last, sources: last.sources || [], id: streamId, isAnalysisMessage: true }]
      }
      return [...prev, { role: 'assistant', content: '', sources: [], id: streamId, isAnalysisMessage: true }]
    })

    let fullResponse = ''
    let streamedSuggestions = null
    try {
      await streamChat({
        message: fullPrompt,
        history: historyRef.current,
        data_context: contextOverride ? { ...(analysisContext || {}), ...contextOverride } : analysisContext ?? null,
        kb_scope: 'general',
        conversationId: conversationIdRef.current,
        accessToken,
        internal: true,
        onChunk: chunk => {
          fullResponse += chunk
          if (chunk.match(/\*{0,2}SUGGESTIONS_JSON\*{0,2}\s*:/i) || fullResponse.match(/\*{0,2}SUGGESTIONS_JSON\*{0,2}\s*:/i)) {
            const partial = stripSuggestionsFromText(fullResponse)
            if (partial.suggestions?.length) streamedSuggestions = partial.suggestions
          }
          const display = visibleTextWhileStreaming(fullResponse)
          setMessages((prev) => patchAssistantById(prev, streamId, { content: display }))
        },
        onSources: () => { /* internal analysis streams: no KB / general-knowledge pills */ },
        onConversationId: (id) => {
          conversationIdRef.current = id
          attachConversationToFileSession(id)
          persistActiveConversationId(id)
          onConversationHighlight?.(id)
          onConversationSaved?.()
        },
        onReplaceText: (nextText) => {
          const stripped = stripSuggestionsFromText(nextText || '')
          fullResponse = stripped.text
          if (stripped.suggestions?.length) streamedSuggestions = stripped.suggestions
          setMessages((prev) => patchAssistantById(prev, streamId, { content: fullResponse }))
        },
        onViz: (viz) => {
          if (!suppressViz) {
            setMessages((prev) => patchAssistantById(prev, streamId, { viz }))
          }
        },
        onSuggestions: (suggestions) => { streamedSuggestions = suggestions },
      })
      let finalText = fullResponse
      if (stripMarkdownTables && finalText) {
        finalText = sanitizeStudentListAssistantText(finalText)
      }
      const finalized = finalizeAssistantMessage(setMessages, finalText, streamedSuggestions, streamId)
      finalText = finalized.text
      streamedSuggestions = finalized.suggestions
      const fallbackViz = extractVizFromText(finalText)
      if (fallbackViz && !suppressViz) {
        setMessages((prev) => {
          const existing = prev.find(m => m.id === streamId)
          const existingType = existing?.viz?.type
          if (existingType && fallbackViz.type !== existingType) return prev
          return patchAssistantById(prev, streamId, { viz: fallbackViz })
        })
      }
      if (streamedSuggestions?.length && conversationIdRef.current && finalText.trim()) {
        void updateMessageSuggestions(conversationIdRef.current, finalText, streamedSuggestions, accessToken).catch(() => {})
      }
      pushHistory('assistant', finalText)
      await maybeApplyThresholdFromAssistant(finalText)
      return { ok: true, suggestions: streamedSuggestions, content: finalText }
    } catch (err) {
      setMessages((prev) =>
        patchAssistantById(prev, streamId, {
          content: 'Sorry, something went wrong. Please try again.',
        }),
      )
      return { ok: false, suggestions: null, content: '' }
    } finally {
      setIsStreaming(false)
    }
  }

  async function runGradeBreakdownFlow() {
    const risk = analysisContext?.risk
    const gradeViz = buildGradeComparisonViz(risk?.grade_summary)
    if (!gradeViz) return
    setMessages((prev) => [...prev, { role: 'assistant', content: '', sources: [], viz: gradeViz }])
    await appendAssistantStream(
      'The grade breakdown card above already shows per-grade tiles and bars. Write exactly 2-3 short sentences grounded ONLY in grade_summary / grades in CURRENT ANALYSIS DATA. Name the specific grade(s) with highest risk and cite 2-3 real numbers from the data (counts or percentages for two-plus flags, chronic absence, academic failure, or all-three flags). Compare grades directly (e.g. Grade 6 vs Grade 7) — not a vague school-wide essay. Do not speculate about causes (e.g. students "catching up" a year later) unless the data clearly show it. Do not cite research or knowledge-base sources. No markdown tables.',
      { risk, grade_summary: risk?.grade_summary, grades: gradeViz.grades },
      { attachToLastWithViz: true },
    )
  }

  function buildClassifierContext() {
    const fd = getFileData()
    const mapping = fd?.mapping || analysisContext?.mapping || {}
    const r = analysisContext?.risk
    const thresholds = analysisContext?.thresholds || {}
    const mapped_columns = {}
    for (const [role, col] of Object.entries(mapping)) {
      if (role.startsWith('_')) continue
      if (typeof col === 'string' && col) mapped_columns[role] = col
      else if (Array.isArray(col) && col.length) mapped_columns[role] = col
    }
    const demographic_roles = ['ell', 'lep', 'low_ses', 'special_ed'].filter(
      (role) => mapped_columns[role],
    )
    return {
      stage: analysisStage || null,
      mapped_columns,
      demographic_roles,
      thresholds,
      total_students: r?.total ?? null,
      critical_count: r?.critical ?? null,
      all_three_count: r?.overlap?.all_three?.count ?? null,
      two_or_more_count: r?.overlap?.two_or_more?.count ?? null,
      grade_summary: r?.grade_summary ?? null,
      sel_available: Boolean(analysisContext?.sel?.available),
      suspension_min_threshold: thresholds?.suspension_min ?? null,
      last_student_list: lastStudentListRef.current || null,
    }
  }

  /** Thin numeric fallback when classifier omits filters (prefer intent.filters). */
  function parseQueryFiltersFromText(text) {
    const lower = (text || '').toLowerCase()
    const out = {}
    const failM =
      lower.match(/(\d+)\s*\+?\s*(?:or\s+more\s+)?(?:course\s*)?fail/i) ||
      lower.match(/(\d+)\s*\+?\s*courses?\s*failed/i)
    if (failM) out.min_course_failures = parseInt(failM[1], 10)
    const susp = lower.match(/(\d+)\s*\+?\s*suspension/)
    if (susp) out.min_suspension_count = parseInt(susp[1], 10)
    return out
  }

  function resolveIntentFilters(intent, text) {
    const textFallback = parseQueryFiltersFromText(text)
    const fromIntent = intent?.filters && typeof intent.filters === 'object' ? intent.filters : {}
    return { ...textFallback, ...fromIntent }
  }

  /** When mapping already has the needed columns, run the student query directly (no clarify loop). */
  function tryDirectStudentQuery(text) {
    const fd = getFileData()
    const mapping = fd?.mapping
    if (!fd?.file_id || !mapping) return null
    const lower = (text || '').toLowerCase()
    if (!/how many|which of|count|would that be|have \d+\+/.test(lower)) return null
    const grade = extractGradeFromText(text)
    const triple =
      /triple[- ]?flag|all three|three indicators|3 flags|triple-flagged/.test(lower)
    if (!triple && !grade) return null
    const queryFilters = parseQueryFiltersFromText(text)
    if (queryFilters.demographic_subset === 'ell' && !(mapping.ell || mapping.lep)) return null
    if (queryFilters.demographic_subset === 'low_ses' && !mapping.low_ses) return null
    if (queryFilters.min_suspension_count != null && !mapping.behavior) return null
    return {
      tier: triple ? 'triple' : 'critical',
      grade,
      queryFilters,
    }
  }

  function _buildSELIntentFromClarifications(originalText, selections) {
    const lower = (originalText || '').toLowerCase()
    if (!/sel|well.?being|social.?emotional|survey|score|factor/i.test(lower)) return null
    if (!selections?.length) return null

    const SEL_DIMENSION_MAP = {
      ell_vs_non_ell: 'ell', ell: 'ell',
      sped_vs_non_sped: 'special_ed', sped: 'special_ed',
      low_ses_vs_non_low_ses: 'low_ses', low_ses: 'low_ses',
    }

    const dimensions = []
    const grades = []

    for (const selection of selections) {
      for (const optId of (selection.optionIds || [])) {
        const id = (optId || '').toLowerCase()
        if (SEL_DIMENSION_MAP[id]) {
          if (!dimensions.includes(SEL_DIMENSION_MAP[id]))
            dimensions.push(SEL_DIMENSION_MAP[id])
          continue
        }
        const gradeMatch = id.match(/grade[_\s]?(\d+)/)
        if (gradeMatch && !grades.includes(gradeMatch[1]))
          grades.push(gradeMatch[1])
      }
    }

    // Need at least a dimension or explicit grade list to do anything
    if (!dimensions.length && !grades.length) return null

    const selFilters = {}

    if (grades.length >= 2) {
      // Multi-grade compare — dimension is secondary
      selFilters.sel_compare_grades = grades
    } else if (dimensions.length === 1) {
      selFilters.sel_compare_dimension = dimensions[0]
      const grade = grades[0] || extractGradeFromText(originalText)
      if (grade) selFilters.sel_compare_grade = grade
    } else if (dimensions.length > 1) {
      // Multiple demographics selected — can't collapse to one SEL card,
      // let the normal re-classify path handle it
      return null
    }

    if (!Object.keys(selFilters).length) return null

    return {
      action: 'execute',
      confidence: 1.0,
      outputs: [{ type: 'sel', filters: selFilters }],
    }
  }

  function showClarifyWizard(originalMessage, intent) {
    const clarify = intent?.clarify
    if (!clarify?.steps?.length) return false
    if (clarifyRoundRef.current >= 2) {
      clarifyRoundRef.current = 0
      void (async () => {
        const retryIntent = await classifyTeacherIntent(originalMessage, analysisStage)
        if (retryIntent?.action === 'execute' && retryIntent.outputs?.length) {
          await executeIntentOutputs(retryIntent, originalMessage, lastKbScopeRef.current)
        } else {
          await handleSend(originalMessage, lastKbScopeRef.current, false, { skipUserMessage: true })
        }
      })()
      return true
    }
    clarifyRoundRef.current += 1
    setMessages((prev) => [
      ...prev.filter((m) => m.type !== 'clarify_wizard'),
      {
        role: 'assistant',
        content: clarify.intro || 'A few quick questions so I route this correctly.',
        sources: [],
      },
      {
        role: 'card',
        type: 'clarify_wizard',
        data: { intro: clarify.intro, steps: clarify.steps, originalMessage },
        onComplete: (selections) => { void handleClarifyResolved(originalMessage, selections) },
        onSkip: () => { void handleClarifySkipped(originalMessage) },
      },
    ])
    pushHistory('assistant', clarify.intro || 'Clarifying how to answer.')
    return true
  }

  async function handleClarifyResolved(originalText, selections) {
    const lines = (selections || [])
      .filter((s) => s.labels?.length)
      .map((s) => `${s.stepTitle}: ${s.labels.join(', ')}`)
    const enriched =
      lines.length > 0
        ? `${originalText}\n\nClarifications:\n${lines.map((l) => `- ${l}`).join('\n')}`
        : originalText
    setMessages((prev) => prev.filter((m) => m.type !== 'clarify_wizard'))
    pushHistory('user', enriched)

    // Try to reconstruct a typed intent directly from selections before re-classifying.
    // The "Clarifications:" block format confuses the classifier into returning chat.
    const directSELIntent = _buildSELIntentFromClarifications(originalText, selections)
    if (directSELIntent) {
      clarifyRoundRef.current = 0
      await executeIntentOutputs(directSELIntent, enriched, lastKbScopeRef.current)
      return
    }

    let intent = await classifyTeacherIntent(enriched, analysisStage)
    if (!intent) intent = { action: 'chat' }
    if (intent.action === 'clarify') {
      if (!showClarifyWizard(enriched, intent)) {
        clarifyRoundRef.current = 0
        await handleSend(enriched, lastKbScopeRef.current, false, { skipUserMessage: true })
      }
      return
    }
    clarifyRoundRef.current = 0
    if (await dispatchClassifiedIntent(intent, enriched, lastKbScopeRef.current)) return
    await handleSend(enriched, lastKbScopeRef.current, false, { skipUserMessage: true })
  }

  async function handleClarifySkipped(originalText) {
    setMessages((prev) => prev.filter((m) => m.type !== 'clarify_wizard'))
    pushHistory('user', originalText)
    await handleSend(originalText, lastKbScopeRef.current, false, { skipUserMessage: true })
  }

  /** One dispatcher: classifier picks action + analysis_type; UI runs the matching card. */
  async function dispatchClassifiedIntent(intent, text, kbScope = 'general') {
    if (!intent?.action) return false

    if (intent.action === 'clarify') {
      return showClarifyWizard(text, intent)
    }

    if (intent.action === 'execute') {
      const CARD_OUTPUT_TYPES = new Set([
        'student_list', 'analysis', 'sel', 'group_comparison', 'artifact'
      ])
      const needsCard = intent.outputs?.some(o => CARD_OUTPUT_TYPES.has(o?.type))
      if (intent.answerable_from_context && !needsCard) {
        intent.action = 'chat'
        // fall through to chat handler below
      } else {
        clarifyRoundRef.current = 0
        if (await executeIntentOutputs(intent, text, kbScope)) return true
      }
    }

    if (intent.action === 'chat') {
      if (intent.answerable_from_context) {
        // Try answering from context first via appendAssistantStream
        // but instruct Claude: if exact data isn't available, say so in
        // ONE sentence then stop — don't explain at length
        const result = await appendAssistantStream(
          `The teacher asked: "${text}"\n\n` +
          `INSTRUCTION:\n` +
          `1. If the exact answer is in CURRENT ANALYSIS DATA, answer in 2-3 sentences. ` +
          `Only output a chart if ALL groups use the same metric and population. ` +
          `Choose chart type: horizontalBar for ranked categories, bar for grade comparisons, ` +
          `radar for multi-factor, doughnut for part-of-whole.\n` +
          `2. If the exact answer requires data not in loaded results: ` +
          `output ONLY the single word NEEDS_COMPUTATION on its own line. ` +
          `No explanation before it. No text after it. Just: NEEDS_COMPUTATION\n` +
          `3. Only use exact numbers from CURRENT ANALYSIS DATA. Never estimate. ` +
          `Only include positive demographic groups — exclude Non-ELL, No IEP etc. ` +
          `CRITICAL ORDERING RULE: Before writing any summary, sort all values numerically. ` +
          `Always name the highest value first. Never write "X is highest" when a larger ` +
          `value exists elsewhere in the data. Check every number before writing. ` +
          `Never correct yourself mid-sentence. State the ranking correctly the first time. ` +
          `Never write lead-in phrases before a viz block. ` +
          `Never end your response with a colon or incomplete sentence like "Here's how..." ` +
          `Write in plain prose — no bullet points, no headers, no bold labels. ` +
          `If the question asks about multiple metrics, pick the single most relevant one for the chart, ` +
          `then mention the other in one sentence of prose. Maximum 3 sentences total. ` +
          `State your complete answer and stop.`,
          analysisContext,
          { suppressViz: false, includeSuggestions: false },
        )
        // If Claude signaled it needs computation, run group_comparison
        if (result?.content?.includes('NEEDS_COMPUTATION')) {
          setMessages(prev => prev.filter(m => !m.content?.includes('NEEDS_COMPUTATION')))
          if (hasUploadedData()) {
            try {
              await runCustomGroupComparison(text, 'indicators')
            } catch (e) {
              // group_comparison failed — fall back to best available answer from context
              await appendAssistantStream(
                `The teacher asked: "${text}"\n\n` +
                `INSTRUCTION: The exact computation wasn't possible. ` +
                `Answer in 2 sentences using whatever is available in CURRENT ANALYSIS DATA. ` +
                `Then in one sentence tell the teacher what to ask to get the precise answer.`,
                analysisContext,
                { suppressViz: true },
              )
            }
          }
        }
        return true
      }
      if (hasUploadedData()) {
        try {
          await runCustomGroupComparison(text, 'indicators')
        } catch (e) {
          // fell through — return false so handleSend streams normally
          return false
        }
        return true
      }
      return false
    }

    return false
  }

  // ── Intent classifier ────────────────────────────────────────────────────

  async function classifyTeacherIntent(text, stage) {
    try {
      const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
      const headers = { 'Content-Type': 'application/json' }
      if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken
      const response = await fetch(API_URL + '/chat/classify-intent', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: text,
          stage: stage || null,
          has_file: hasUploadedData(),
          context_summary: buildClassifierContext(),
        }),
      })
      if (!response.ok) return null
      return await response.json()
    } catch (e) {
      console.warn('[classifyTeacherIntent] failed:', e)
      return null
    }
  }

  // ── Main send handler ────────────────────────────────────────────────────

  async function handleSend(text, kbScope = 'global', fromSuggestion = false, sendOpts = {}) {
    text = normalizeSuggestionText(text)
    if (!text) return
    console.log('[handleSend] stage=', analysisStage, 'message=', text.slice(0, 60))
    lastKbScopeRef.current = kbScope || 'general'
    const lower = text.toLowerCase()
    const skipUserMessage = Boolean(sendOpts.skipUserMessage)
    actionInFlightRef.current = true
    try {
    await ensureFileDataReady()

    // Canonical path: backend classifier returns action or a dynamic clarify wizard — no frontend guessing.
    if (!skipUserMessage) {
      setMessages((prev) => [...prev, { role: 'user', content: text, id: `user-${Date.now()}` }])
      pushHistory('user', text)
    } else {
      pushHistory('user', text)
    }

    // Enrich short affirmative responses with last assistant context
    // so classifier knows what "yes/sure/ok" refers to
    const isAffirmative = /^(yes|sure|ok|okay|please|go ahead|do it|yep|yeah)\.?$/i.test(text.trim())
    if (isAffirmative) {
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content)
      if (lastAssistant?.content) {
        const context = lastAssistant.content.slice(-300).trim()
        text = `${text} (the teacher is confirming this offer from the previous response: "${context}")`
      }
    }

    let intent = await classifyTeacherIntent(text, analysisStage)
    console.log('[intent]', JSON.stringify(intent, null, 2))  // TODO: remove before prod
    if (!intent) intent = { action: 'chat', confidence: 0 }
    if (await dispatchClassifiedIntent(intent, text, kbScope)) return

    const streamId = `stream-${Date.now()}`
    setIsStreaming(true)
    pendingSuggestionsRef.current = null
    setMessages((prev) => [...prev, { role: 'assistant', content: '', sources: [], id: streamId }])
    let fullResponse = ''
    let streamedSuggestions = null
    const userAlreadyInHistory =
      historyRef.current[historyRef.current.length - 1]?.role === 'user' &&
      historyRef.current[historyRef.current.length - 1]?.content === text

    try {
      await streamChat({
        message: text,
        history: historyRef.current,
        data_context: analysisContext ?? null,
        kb_scope: kbScope,
        conversationId: conversationIdRef.current,
        accessToken,
        onChunk: chunk => {
          fullResponse += chunk
          if (fullResponse.match(/\*{0,2}SUGGESTIONS_JSON\*{0,2}\s*:/i)) {
            const partial = stripSuggestionsFromText(fullResponse)
            if (partial.suggestions?.length) streamedSuggestions = partial.suggestions
          }
          const display = visibleTextWhileStreaming(fullResponse)
          setMessages((prev) => patchAssistantById(prev, streamId, { content: display }))
        },
        onSources: (sources) => {
          setMessages((prev) => patchAssistantById(prev, streamId, { sources }))
        },
        onConversationId: (id) => { conversationIdRef.current = id; attachConversationToFileSession(id); persistActiveConversationId(id); onConversationHighlight?.(id); onConversationSaved?.() },
        onReplaceText: (nextText) => {
          const stripped = stripSuggestionsFromText(nextText || '')
          fullResponse = stripped.text
          if (stripped.suggestions?.length) streamedSuggestions = stripped.suggestions
          setMessages((prev) => patchAssistantById(prev, streamId, { content: fullResponse }))
        },
        onViz: (viz) => { setMessages((prev) => patchAssistantById(prev, streamId, { viz })) },
        onSuggestions: (suggestions) => { streamedSuggestions = suggestions; pendingSuggestionsRef.current = suggestions },
      })

      const finalized = finalizeAssistantMessage(
        setMessages,
        fullResponse,
        streamedSuggestions || pendingSuggestionsRef.current,
        streamId,
      )
      fullResponse = finalized.text
      streamedSuggestions = finalized.suggestions
      if (streamedSuggestions?.length && conversationIdRef.current && fullResponse.trim()) {
        void updateMessageSuggestions(conversationIdRef.current, fullResponse, streamedSuggestions, accessToken).catch(() => {})
      }
      const fallbackViz = extractVizFromText(fullResponse)
      if (fallbackViz) {
        setMessages((prev) => patchAssistantById(prev, streamId, { viz: fallbackViz }))
      }
      if (!userAlreadyInHistory) pushHistory('user', text)
      pushHistory('assistant', fullResponse)
      await maybeApplyThresholdFromAssistant(fullResponse)
    } catch (err) {
      setMessages((prev) =>
        patchAssistantById(prev, streamId, {
          content: 'Sorry, something went wrong. Please try again.',
        }),
      )
    } finally { setIsStreaming(false) }
    } finally {
      actionInFlightRef.current = false
    }
  }

  function handleStarterClick(text) {
    if (text === 'Foundational Analysis' || text === 'Ask about my data') {
      intentRef.current = text === 'Foundational Analysis' ? 'foundational_analysis' : 'ask_data'
      intentRef._setByStarter = true
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: text },
        {
          role: 'assistant',
          content:
            text === 'Foundational Analysis'
              ? 'To run foundational analysis, upload your student data file (CSV or Excel) using the upload button below. I’ll map your columns and walk you through criteria before running the analysis.'
              : 'Upload your student data file (CSV or Excel) using the upload button below. After I map your columns, tell me what you’d like to explore.',
          sources: [],
        },
      ])
      messageInputRef.current?.openFilePicker?.()
      return
    }
    intentRef.current = null
    intentRef._setByStarter = false
    handleSend(text, 'global', false)
  }
  function handleSuggestionClick(raw) {
    const text = normalizeSuggestionText(raw)
    if (!text) return
    void handleSend(text, 'global', true).catch((err) => {
      console.error('[handleSuggestionClick]', err)
      setIsAnalyzing(false)
      setIsStreaming(false)
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Something went wrong running that action. Please try again or re-upload your data file.',
          sources: [],
        },
      ])
    })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div className="chat-topbar">
        <button className="tbar-btn" onClick={onToggleSidebar} title="Toggle sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <span style={{ flex: 1 }} />
        {artifactOpen && (
          <button className="tbar-btn" onClick={onOpenArtifacts} title="Toggle artifact panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        )}
      </div>

      <MessageList
        messages={messages}
        isStreaming={isStreaming || isAnalyzing || isGeneratingArtifact}
        onStarterClick={handleStarterClick}
        onSuggestionClick={handleSuggestionClick}
        onAddToReport={onAddToReport}
        onAddToNotes={onAddToNotes}
        onViewHighestRiskStudents={handleViewHighestRiskStudents}
        accessToken={accessToken}
      />

      <MessageInput
        ref={messageInputRef}
        onSend={handleSend}
        disabled={isStreaming || isAnalyzing || isGeneratingArtifact}
        onFileSelect={handleFileSelect}
        onOpenArtifacts={onOpenArtifacts}
        fileData={contextFileData}
        thresholds={analysisContext?.thresholds || null}
        csvPreviewOpen={csvPreviewOpen}
        onToggleCsvPreview={() => setCsvPreviewOpen(p => !p)}
        onReopenCriteria={handleReopenCriteria}
        onRemoveFile={handleRemoveFile}
      />
    </div>
  )
}