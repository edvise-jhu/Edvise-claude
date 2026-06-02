import { useState } from 'react'
import { InsightStrips, NextActions } from './shared'

const INDICATOR_KEYS = [
  { name: 'Academic failure', color: '#D85A30' },
  { name: 'Chronic absence', color: '#378ADD' },
  { name: 'Suspensions', color: '#BA7517' },
]

const GRADE_TAB_COLORS = ['#1565c0', '#d32f2f', '#2e7d32', '#7b1fa2', '#f57c00', '#00838f', '#5c6bc0']

function sortGrades(grades) {
  return [...grades].sort((a, b) => {
    const na = parseInt(String(a.label || '').replace(/\D/g, ''), 10)
    const nb = parseInt(String(b.label || '').replace(/\D/g, ''), 10)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return String(a.label || '').localeCompare(String(b.label || ''))
  })
}

function GradePanel({ g }) {
  const gradeTotal = Number(g.n || 0)
  const anyFlagN = Math.round((Number(g.flagged_pct || 0) / 100) * gradeTotal)
  const allThreeRow = (g.indicators || []).find((x) => x.name === 'All 3 flags')
  const allThreeN = Number(allThreeRow?.count || 0)
  const allThreePct = gradeTotal > 0 ? Math.round((allThreeN / gradeTotal) * 100) : 0
  const noFlagN = gradeTotal - anyFlagN
  const noFlagPct = gradeTotal > 0 ? Math.round((noFlagN / gradeTotal) * 100) : 0
  const anyFlagPct = gradeTotal > 0 ? Math.round((anyFlagN / gradeTotal) * 100) : 0

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        {[
          { label: 'Students', val: gradeTotal, sub: 'enrolled', color: '#2A3B7C' },
          { label: 'Any flag', val: anyFlagN, sub: `${anyFlagPct}% of grade`, color: '#b7791f' },
          { label: 'All 3 flags', val: allThreeN, sub: `${allThreePct}% of grade`, color: '#c53030' },
          { label: 'No flags', val: noFlagN, sub: `${noFlagPct}% of grade`, color: '#276749' },
        ].map((t, ti) => (
          <div key={ti} style={{ background: '#f7f9fc', borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ fontSize: 10, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{t.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: t.color }}>{t.val}</div>
            <div style={{ fontSize: 10, color: '#7a89b8', marginTop: 2 }}>{t.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ border: '1px solid #f0f3fa', borderRadius: 10, padding: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
          Risk indicators
        </div>
        {INDICATOR_KEYS.map(({ name, color }) => {
          const ind = (g.indicators || []).find((x) => x.name === name)
          if (!ind) return null
          const n = Number(ind.count || 0)
          const pct = Number(ind.pct || (gradeTotal > 0 ? Math.round((n / gradeTotal) * 100) : 0))
          return (
            <div key={name} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span style={{ fontWeight: 600, color }}>{name}</span>
                <span style={{ color: '#2A3B7C' }}>{n} ({pct}%)</span>
              </div>
              <div style={{ height: 7, background: '#eef2f8', borderRadius: 999 }}>
                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 999, background: color, opacity: 0.85 }} />
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div style={{ background: '#fffbeb', border: '1px solid #fbd38d', borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, color: '#b7791f', marginBottom: 3 }}>2 or more flags</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#b7791f' }}>{anyFlagN}</div>
          <div style={{ fontSize: 10, color: '#b7791f' }}>{anyFlagPct}% of grade</div>
        </div>
        <div style={{ background: '#fff5f5', border: '1px solid #fed7d7', borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontSize: 11, color: '#c53030', marginBottom: 3 }}>All 3 flags</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#c53030' }}>{allThreeN}</div>
          <div style={{ fontSize: 10, color: '#c53030' }}>{allThreePct}% of grade</div>
        </div>
      </div>
    </>
  )
}

export default function GradeComparisonCard({ data, onAction }) {
  const rawGrades = Array.isArray(data?.grades) ? data.grades : []
  const grades = sortGrades(rawGrades)
  const [activeGrade, setActiveGrade] = useState(0)

  if (!grades.length) {
    return (
      <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, padding: 16, marginTop: 10, background: '#fff', color: '#7a89b8', fontSize: 13 }}>
        No grade-level data available.
      </div>
    )
  }

  const safeIndex = Math.min(activeGrade, grades.length - 1)
  const g = grades[safeIndex]

  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, overflow: 'hidden', marginTop: 10, background: '#fff' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e4e9f2', background: '#f7f9fc' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#2A3B7C', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          {data?.title || 'Grade breakdown'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {grades.map((grade, i) => {
            const c = GRADE_TAB_COLORS[i % GRADE_TAB_COLORS.length]
            const isActive = i === safeIndex
            return (
              <button
                key={grade.label || i}
                type="button"
                onClick={() => setActiveGrade(i)}
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
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
                {grade.label}
                <span style={{ fontSize: 10, color: '#7a89b8', fontWeight: 400 }}>n={Number(grade.n || 0).toLocaleString()}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ padding: 12 }}>
        <GradePanel g={g} />
        <InsightStrips insights={data?.insights} />
        <NextActions actions={data?.next_actions} onAction={onAction} />
      </div>
    </div>
  )
}
