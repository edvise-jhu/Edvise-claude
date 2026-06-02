/** Build default criteria + API thresholds from mapping and upload preview. */

const COURSE_ROLE_META = {
  math: { label: 'Math', mappingKey: 'math' },
  english: { label: 'English', mappingKey: 'english' },
  failtot: { label: 'Total courses failed', mappingKey: 'failtot', isCount: true },
}

const LETTER_GRADE_RE = /^[A-F][+-]?$/i

export function detectColumnFormat(column, previewRows = []) {
  const values = (previewRows || [])
    .map((r) => r[column])
    .filter((v) => v !== '' && v != null && v !== undefined)

  if (!values.length) return 'binary'

  const strVals = values.map((v) => String(v).trim())
  const letterHits = strVals.filter((v) => LETTER_GRADE_RE.test(v)).length
  if (letterHits / values.length >= 0.4) return 'letter'

  const binaryHits = values.filter((v) => {
    const n = Number(v)
    return v === 0 || v === 1 || v === '0' || v === '1' || n === 0 || n === 1
  }).length
  if (binaryHits / values.length >= 0.6) return 'binary'

  const nums = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n))
  if (nums.length / values.length >= 0.6) {
    if (nums.some((n) => n > 1 && n <= 100)) return 'numeric'
    return 'count'
  }

  return 'binary'
}

export function buildCourseRulesFromMapping(mapping, previewRows = [], columnMetadata = {}) {
  const rules = []
  const usedCols = new Set()

  Object.entries(COURSE_ROLE_META).forEach(([roleKey, meta]) => {
    const col = mapping?.[meta.mappingKey]
    if (!col || usedCols.has(col)) return
    usedCols.add(col)

    const format = meta.isCount ? 'count' : detectColumnFormat(col, previewRows)
    const label =
      columnMetadata?.[col]?.label?.replace(/^[^:]+:\s*/i, '') ||
      meta.label

    rules.push({
      id: roleKey,
      key: meta.mappingKey,
      column: col,
      label,
      format,
      letter_rule: 'F_only',
      numeric_below: 60,
      min_count: 1,
    })
  })

  return rules
}

export function buildDefaultCriteria(mapping, previewRows = [], columnMetadata = {}) {
  const hasAttendance = Boolean(mapping?.attendance)
  const hasDaysAbsent = Boolean(mapping?.days_absent)
  const courseRules = buildCourseRulesFromMapping(mapping, previewRows, columnMetadata)

  let absenceBasis = 'rate'
  if (hasDaysAbsent && !hasAttendance) absenceBasis = 'days'
  if (hasAttendance) absenceBasis = 'rate'

  return {
    chronicPct: 10,
    severePct: 20,
    totalSchoolDays: 180,
    suspensionMin: 1,
    academicPreset: 'fail_f_in_1',
    academicMinCourses: 1,
    absenceBasis,
    courseRules,
  }
}

export function applyAcademicPreset(preset, courseRules) {
  const rules = (courseRules || []).map((r) => ({ ...r }))

  if (preset === 'fail_f_in_1') {
    rules.forEach((r) => {
      if (r.format === 'letter') r.letter_rule = 'F_only'
      if (r.format === 'count') r.min_count = 1
    })
    return { academicMinCourses: 1, courseRules: rules }
  }
  if (preset === 'fail_f_in_2') {
    rules.forEach((r) => {
      if (r.format === 'letter') r.letter_rule = 'F_only'
    })
    return { academicMinCourses: 2, courseRules: rules }
  }
  if (preset === 'fail_d_in_1') {
    rules.forEach((r) => {
      if (r.format === 'letter') r.letter_rule = 'D_or_below'
    })
    return { academicMinCourses: 1, courseRules: rules }
  }
  if (preset === 'failtot_min') {
    const only = rules.filter((r) => r.key === 'failtot')
    return { academicMinCourses: 1, courseRules: only.length ? only : rules }
  }
  if (preset === 'binary_any') {
    rules.forEach((r) => {
      if (r.key !== 'failtot') r.format = 'binary'
    })
    return { academicMinCourses: 1, courseRules: rules }
  }

  return { academicMinCourses: 1, courseRules: rules }
}

/** Map stored API thresholds back into UI criteria (for re-opening the criteria card). */
export function thresholdsToCriteria(thresholds, baseCriteria) {
  if (!thresholds || typeof thresholds !== 'object') return baseCriteria
  const next = { ...baseCriteria }
  if (thresholds.chronic_absence_threshold != null) {
    next.chronicPct = Math.round(Number(thresholds.chronic_absence_threshold) * 100)
  }
  if (thresholds.severe_absence_threshold != null) {
    next.severePct = Math.round(Number(thresholds.severe_absence_threshold) * 100)
  }
  if (thresholds.suspension_min != null) {
    next.suspensionMin = Number(thresholds.suspension_min)
  }
  if (thresholds.academic_min_courses != null) {
    next.academicMinCourses = Number(thresholds.academic_min_courses)
  }
  if (thresholds.absence_basis) {
    next.absenceBasis = thresholds.absence_basis
  }
  if (thresholds.total_school_days != null) {
    next.totalSchoolDays = Number(thresholds.total_school_days)
  }
  if (thresholds.academic_preset) {
    next.academicPreset = thresholds.academic_preset
  }
  if (Array.isArray(thresholds.course_rules) && thresholds.course_rules.length) {
    next.courseRules = thresholds.course_rules.map((r, i) => ({
      id: r.id || r.key || `rule_${i}`,
      key: r.key,
      column: r.column,
      label: r.label,
      format: r.format,
      letter_rule: r.letter_rule || 'F_only',
      numeric_below: r.numeric_below ?? 60,
      min_count: r.min_count ?? 1,
    }))
  }
  return next
}

/** Map UI criteria object → backend thresholds dict. */
export function criteriaToThresholds(criteria) {
  const presetPatch = applyAcademicPreset(criteria.academicPreset, criteria.courseRules)
  const courseRules = (presetPatch.courseRules || criteria.courseRules || []).map((r) => ({
    key: r.key,
    column: r.column,
    label: r.label,
    format: r.format,
    letter_rule: r.letter_rule || 'F_only',
    numeric_below: r.numeric_below ?? 60,
    min_count: r.min_count ?? 1,
  }))

  return {
    chronic_absence_threshold: (criteria.chronicPct ?? 10) / 100,
    severe_absence_threshold: (criteria.severePct ?? 20) / 100,
    total_school_days: criteria.totalSchoolDays ?? 180,
    suspension_min: criteria.suspensionMin ?? 1,
    academic_min_courses: presetPatch.academicMinCourses ?? criteria.academicMinCourses ?? 1,
    absence_basis: criteria.absenceBasis || 'rate',
    course_rules: courseRules,
    academic_preset: criteria.academicPreset,
  }
}

const THRESHOLD_KEYS = [
  'chronic_absence_threshold',
  'severe_absence_threshold',
  'total_school_days',
  'suspension_min',
  'academic_min_courses',
  'absence_basis',
  'course_rules',
  'academic_preset',
]

/** Merge partial threshold updates (e.g. from chat JSON) with existing payload. */
export function pickThresholds(o) {
  if (!o || typeof o !== 'object') return null
  const out = {}
  THRESHOLD_KEYS.forEach((k) => {
    if (o[k] !== undefined && o[k] !== null) out[k] = o[k]
  })
  return Object.keys(out).length ? out : null
}

export function unusedColumnsForCourses(mapping, courseRules, allColumns = []) {
  const mapped = new Set([
    mapping?.math,
    mapping?.english,
    mapping?.failtot,
    ...(courseRules || []).map((r) => r.column),
  ].filter(Boolean))
  return (allColumns || []).filter((c) => !mapped.has(c))
}
