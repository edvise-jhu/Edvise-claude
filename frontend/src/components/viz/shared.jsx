export const LEVEL_COLORS = {
  red: { bg: '#FCEBEB', fg: '#791F1F' },
  amber: { bg: '#FAEEDA', fg: '#633806' },
  teal: { bg: '#E1F5EE', fg: '#1D9E75' },
}

export function InsightStrips({ insights = [] }) {
  if (!Array.isArray(insights) || insights.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
      {insights.map((it, idx) => {
        const c = LEVEL_COLORS[it?.level] || { bg: '#f3f4f6', fg: '#444' }
        return (
          <div key={idx} style={{ background: c.bg, color: c.fg, borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
            {it?.text}
          </div>
        )
      })}
    </div>
  )
}

export function NextActions({ actions = [], onAction }) {
  if (!Array.isArray(actions) || actions.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      {actions.map((a, i) => {
        const label = typeof a === 'string' ? a : (a.label || a.type || 'Action')
        return (
          <button key={i} className="sug-btn" onClick={() => onAction?.(a)}>{label}</button>
        )
      })}
    </div>
  )
}
