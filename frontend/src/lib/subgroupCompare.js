/** Last resort if classifier and backend inference both omit metrics. */
export const DEFAULT_SUBGROUP_COMPARE = [
  { field: 'cohort_pct', label: 'Course failure' },
  { field: 'chronic_absent_pct', label: 'Chronic absence' },
]

const ALLOWED_FIELDS = new Set([
  'cohort_pct',
  'chronic_absent_pct',
  'suspended_pct',
  'two_or_more_pct',
  'flagged_pct',
  'all_three_pct',
])

/** Use classifier output when present; otherwise a neutral default pair. */
export function resolveSubgroupCompare(step) {
  const raw = step?.subgroup_compare
  if (Array.isArray(raw) && raw.length) {
    const cleaned = raw
      .filter((m) => m && ALLOWED_FIELDS.has(m.field))
      .slice(0, 2)
      .map((m) => ({
        field: m.field,
        label: m.label || m.field,
        description: m.description || '',
      }))
    if (cleaned.length) return cleaned
  }
  return DEFAULT_SUBGROUP_COMPARE.map((m) => ({ ...m }))
}

export function metricPct(group, metric) {
  if (!group || !metric?.field) return 0
  const v = group[metric.field]
  return typeof v === 'number' ? v : 0
}

export function buildCompareSubtitle(metrics) {
  const parts = (metrics || []).map((m) => {
    const desc = m.description ? ` (${m.description})` : ''
    return `${m.label}${desc}`
  })
  if (!parts.length) return 'Rates within each demographic group'
  return `Rates within each group · ${parts.join(' vs ')}`
}

export function buildSchoolWideHighlights(categories, metrics) {
  const list = metrics?.length ? metrics : DEFAULT_SUBGROUP_COMPARE
  const leaders = list.map((metric) => {
    let top = null
    for (const cat of categories || []) {
      for (const g of cat.groups || []) {
        const pct = metricPct(g, metric)
        if (!top || pct > top.pct) {
          top = { tab: cat.tab_label, name: g.name, pct, metric }
        }
      }
    }
    return top
  })
  return { metrics: list, leaders: leaders.filter(Boolean) }
}

export function buildSubgroupSummaryPrompt(highlights) {
  const leaders = highlights?.leaders || []
  if (!leaders.length) {
    return 'Summarize the school-wide subgroup analysis in 2-3 sentences using the card. Compare across ALL tabs, not only the active tab. No markdown tables.'
  }
  const parts = leaders.map(
    (l) => `highest ${l.metric.label}: ${l.name} (${l.tab}, ${l.pct}%)`,
  )
  return (
    `Summarize the school-wide subgroup analysis in 2-3 sentences. The card compares: ${parts.join('; ')}. `
    + 'Use school_wide_highlights in the subgroup payload. Compare across ALL tabs (race, gender, SPED, ELL, SES), not only the active tab. '
    + 'Mention one equity note if present. No markdown tables.'
  )
}
