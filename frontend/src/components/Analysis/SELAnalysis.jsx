import { useEffect, useState } from 'react'

const GROUP_LABELS = {
  triple_flag: 'All 3 indicators',
  chronically_absent: 'Chronically Absent',
  suspended: 'Suspended',
  failing_courses: 'Failing Courses',
  on_track: 'On Track',
}

const GROUP_COLORS = {
  triple_flag: '#DC2626',
  chronically_absent: '#F97316',
  suspended: '#EF4444',
  failing_courses: '#8B5CF6',
  on_track: '#10B981',
}

const GRADE_COLORS = ['#1565c0', '#d32f2f', '#2e7d32', '#7b1fa2', '#f57c00', '#00838f', '#5c6bc0']

const GROUP_ORDER = ['triple_flag', 'chronically_absent', 'suspended', 'failing_courses', 'on_track']

const SCALE_MAX = 5

function compositeAvg(averagesObj) {
  const vals = Object.values(averagesObj || {})
    .map(Number)
    .filter((n) => !Number.isNaN(n))
  if (!vals.length) return null
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
}

function groupLabel(key, group) {
  if (group?.label) return group.label
  if (key.startsWith('grade_')) return `Grade ${key.replace('grade_', '')}`
  return GROUP_LABELS[key] || key
}

function groupColor(key, index) {
  if (key.startsWith('grade_')) return GRADE_COLORS[index % GRADE_COLORS.length]
  return GROUP_COLORS[key] || '#3E94A5'
}

function orderedGroups(groupsMap, mode) {
  const entries = Object.entries(groupsMap || {})
  if (mode === 'custom_group_compare') {
    return entries  // preserve insertion order from resolve_custom_groups
  }
  if (mode === 'demographic_compare') {
    return entries.sort((a, b) => {
      if (a[0].endsWith('_no')) return -1
      if (b[0].endsWith('_no')) return 1
      return String(a[0]).localeCompare(String(b[0]))
    })
  }
  if (mode === 'grade_compare') {
    return entries.sort((a, b) => {
      const ga = Number(a[1]?.grade ?? a[0].replace('grade_', ''))
      const gb = Number(b[1]?.grade ?? b[0].replace('grade_', ''))
      if (!Number.isNaN(ga) && !Number.isNaN(gb)) return ga - gb
      return String(a[0]).localeCompare(String(b[0]))
    })
  }
  const byKey = Object.fromEntries(entries)
  const ordered = GROUP_ORDER.filter((k) => byKey[k]).map((k) => [k, byKey[k]])
  const rest = entries.filter(([k]) => !GROUP_ORDER.includes(k))
  return [...ordered, ...rest]
}

function formatScore(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

function ScoreBar({ value, color, label }) {
  const width = `${Math.min(100, (Number(value) / SCALE_MAX) * 100)}%`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
      <div style={{ flex: 1, height: 9, background: '#eef2f8', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width, height: '100%', borderRadius: 4, background: color }} />
      </div>
      <div
        style={{ width: 32, fontSize: 12, fontWeight: 700, color: '#2A3B7C', textAlign: 'right', flexShrink: 0 }}
        aria-label={label}
      >
        {formatScore(value)}
      </div>
    </div>
  )
}

function defaultGroupIndex(data) {
  const groups = orderedGroups(data?.groups, data?.mode)
  const key = data?.default_group
  if (key) {
    const idx = groups.findIndex(([k]) => k === key)
    if (idx >= 0) return idx
  }
  return 0
}

export default function SELAnalysis({ data }) {
  const [activeGroup, setActiveGroup] = useState(() => defaultGroupIndex(data))

  useEffect(() => {
    setActiveGroup(defaultGroupIndex(data))
  }, [data?.default_group, data?.groups, data?.mode])

  if (!data || !data.available) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center', color: '#7a89b8', fontSize: 13 }}>
        No SEL survey columns detected in this dataset.
      </div>
    )
  }

  const factors = Object.keys(data.overall_avg || {})
  const groups = orderedGroups(data.groups, data.mode)
  if (!groups.length) return null

  const isGradeCompare = data.mode === 'grade_compare'
  const isDemoCompare = data.mode === 'demographic_compare'
  const isFocused = data.mode === 'focused'
  const isCustomGroupCompare = data.mode === 'custom_group_compare'
  const showGroupTabs = !isDemoCompare && (isGradeCompare || isCustomGroupCompare || !data.focused) && groups.length > 1
  const [groupKey, group] = groups[activeGroup]
  const color = groupColor(groupKey, activeGroup)
  const label = groupLabel(groupKey, group)

  const dim = data.dimension
  const demoNo = isDemoCompare && dim ? data.groups?.[`${dim}_no`] : null
  const demoYes = isDemoCompare && dim ? data.groups?.[`${dim}_yes`] : null

  const compareLabel = (data.compare_grades || [])
    .map((g) => `Grade ${g}`)
    .join(' vs ')

  if (isDemoCompare && demoNo && demoYes) {
    const baselineLabel = data.overall_label || `Grade ${data.grade} average`
    return (
      <>
        <div style={{ fontSize: 12, color: '#1b6070', marginBottom: 10, padding: '8px 12px', background: '#f0f8fa', borderRadius: 8, border: '1px solid #b8dde6' }}>
          SEL survey data is available in <strong>Grade {data.grade}</strong>. Comparing{' '}
          <strong>{demoYes.label}</strong> (n={demoYes.n?.toLocaleString()}, flag rate {demoYes.flagged_pct}%) vs{' '}
          <strong>{demoNo.label}</strong> (n={demoNo.n?.toLocaleString()}, flag rate {demoNo.flagged_pct}%).
          {data.context_note && <> {data.context_note}</>}
        </div>

        <div style={{ padding: '12px 0 0', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a89b8' }}>
            <div style={{ width: 24, height: 7, borderRadius: 4, background: '#3E94A5' }} />
            {baselineLabel}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a89b8' }}>
            <div style={{ width: 24, height: 7, borderRadius: 4, background: '#10B981' }} />
            {demoNo.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a89b8' }}>
            <div style={{ width: 24, height: 7, borderRadius: 4, background: '#DC2626' }} />
            {demoYes.label}
          </div>
        </div>

        <div style={{ padding: '12px 0 8px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          By factor — {demoYes.label} vs {demoNo.label} (Grade {data.grade})
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {factors.map((f) => (
            <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 110,
                  fontSize: 12,
                  color: '#4A5568',
                  textAlign: 'right',
                  flexShrink: 0,
                  textTransform: 'capitalize',
                  paddingTop: 2,
                }}
              >
                {f.replace(/_/g, ' ')}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <ScoreBar value={data.overall_avg[f]} color="#3E94A5" label={`${baselineLabel} for ${f}`} />
                <ScoreBar value={demoNo.averages?.[f]} color="#10B981" label={`${demoNo.label} for ${f}`} />
                <ScoreBar value={demoYes.averages?.[f]} color="#DC2626" label={`${demoYes.label} for ${f}`} />
              </div>
            </div>
          ))}
        </div>
      </>
    )
  }

  return (
    <>
      {isGradeCompare && (
        <div style={{ fontSize: 12, color: '#1b6070', marginBottom: 10, padding: '8px 12px', background: '#f0f8fa', borderRadius: 8, border: '1px solid #b8dde6' }}>
          SEL survey data is available. Comparing <strong>{compareLabel}</strong> against the school average to explore differences in well-being that may relate to compounding risk.
        </div>
      )}

      {isCustomGroupCompare && (
        <div style={{ fontSize: 12, color: '#1b6070', marginBottom: 10, padding: '8px 12px', background: '#f0f8fa', borderRadius: 8, border: '1px solid #b8dde6' }}>
          Comparing SEL factor scores across{' '}
          <strong>{groups.length} groups</strong> vs the school average.
        </div>
      )}

      {(isFocused || data.focused) && !isGradeCompare && !isDemoCompare && !isCustomGroupCompare && (
        <div style={{ fontSize: 12, color: '#1b6070', marginBottom: 10, padding: '8px 12px', background: '#f0f8fa', borderRadius: 8, border: '1px solid #b8dde6' }}>
          Comparing SEL scores for <strong>{data.focus_label || 'the focal group'}</strong>{' '}
          (n={group.n?.toLocaleString()}) vs the <strong>{data.overall_label || 'baseline'}</strong>.
        </div>
      )}

      <div style={{ paddingBottom: showGroupTabs ? 12 : 0, marginBottom: showGroupTabs ? 4 : 0, borderBottom: showGroupTabs ? '1px solid #e4e9f2' : 'none' }}>
        {showGroupTabs && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {groups.map(([key, g], i) => {
              const c = groupColor(key, i)
              const lbl = groupLabel(key, g)
              const isActive = i === activeGroup
              const groupComposite = compositeAvg(g.averages)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveGroup(i)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 20,
                    border: `1px solid ${isActive ? c : '#e4e9f2'}`,
                    background: isActive ? `${c}18` : 'white',
                    color: isActive ? c : '#7a89b8',
                    fontSize: 12,
                    fontWeight: isActive ? 700 : 500,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    transition: 'all .15s',
                  }}
                >
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                  {lbl}
                  {groupComposite != null && (
                    <span style={{ fontSize: 10, fontWeight: 600, color: isActive ? c : '#7a89b8' }}>
                      {groupComposite}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: '#7a89b8', fontWeight: 400 }}>
                    n={g.n?.toLocaleString()}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div style={{ padding: '12px 0 0', display: 'flex', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a89b8' }}>
          <div style={{ width: 24, height: 7, borderRadius: 4, background: '#10B981' }} />
          School average (1–5)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a89b8' }}>
          <div style={{ width: 24, height: 7, borderRadius: 4, background: color }} />
          {label} ({group.n?.toLocaleString()})
        </div>
      </div>

      <div style={{ padding: '12px 0 8px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        By factor — {label}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {factors.map((f) => {
          const overall = data.overall_avg[f] ?? 0
          const groupVal = group.averages?.[f] ?? 0

          return (
            <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div
                style={{
                  width: 110,
                  fontSize: 12,
                  color: '#4A5568',
                  textAlign: 'right',
                  flexShrink: 0,
                  textTransform: 'capitalize',
                  paddingTop: 2,
                }}
              >
                {f.replace(/_/g, ' ')}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <ScoreBar value={overall} color="#10B981" label={`School average for ${f}`} />
                <ScoreBar value={groupVal} color={color} label={`${label} for ${f}`} />
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
