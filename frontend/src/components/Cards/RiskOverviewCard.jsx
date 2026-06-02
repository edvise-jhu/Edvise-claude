export default function RiskOverviewCard({ data }) {
  if (!data) return null
  const { indicators = {}, overlap = {}, total = 0 } = data
  const thresholds = data.thresholds_used || {}
  const chronic = Math.round((thresholds.chronic_absence_threshold ?? 0.1) * 100)
  const severe = Math.round((thresholds.severe_absence_threshold ?? 0.2) * 100)

  const rows = [
    { key: 'attendance', color: '#2196F3', ind: indicators.attendance },
    { key: 'behavior', color: '#FF9800', ind: indicators.behavior },
    { key: 'academic', color: '#F44336', ind: indicators.academic },
  ]

  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, overflow: 'hidden', background: 'white' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid #e4e9f2', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#2A3B7C' }}>
          School Overview - {total} students
        </span>
        <span style={{ fontSize: 11, color: '#7a89b8' }}>
          Chronic absent &gt;={chronic}% - Severe &gt;={severe}%
        </span>
      </div>

      {rows.map(({ key, color, ind }) => {
        if (!ind) return null
        return (
          <div key={key} style={{ padding: '12px 16px', borderBottom: '1px solid #f0f3fa' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 13, color: '#2A3B7C' }}>{ind.label}</span>
                <span style={{ fontSize: 11, color: '#7a89b8', marginLeft: 8 }}>{ind.description}</span>
              </div>
              <span style={{ fontWeight: 700, fontSize: 15, color }}>
                {Number(ind.count || 0).toLocaleString()} <span style={{ fontSize: 11, fontWeight: 400, color: '#7a89b8' }}>({ind.pct || 0}%)</span>
              </span>
            </div>
            {Object.entries(ind.by_grade || {}).map(([grade, count]) => (
              <div key={grade} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                <span style={{ fontSize: 10, color: '#7a89b8', minWidth: 42 }}>Grade {grade}</span>
                <div style={{ flex: 1, height: 6, background: '#f0f3fa', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.min(100, Math.round(((Number(count) || 0) / (total || 1)) * 100 * 3))}%`,
                      height: '100%',
                      background: color,
                      borderRadius: 3,
                      opacity: 0.7,
                    }}
                  />
                </div>
                <span style={{ fontSize: 10, color: '#2A3B7C', minWidth: 24 }}>{count}</span>
              </div>
            ))}
            {key === 'attendance' && ind.severe && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #e4e9f2', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: '#7a89b8' }}>↳ {ind.severe.label}: {ind.severe.description}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#7B1FA2' }}>
                  {Number(ind.severe.count || 0).toLocaleString()} ({ind.severe.pct || 0}%)
                </span>
              </div>
            )}
          </div>
        )
      })}

      <div style={{ padding: '12px 16px', background: '#fafbff' }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#7a89b8', marginBottom: 8 }}>
          Students carrying multiple indicators
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1, background: 'white', border: '1px solid #e4e9f2', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#FF9800' }}>{Number(overlap?.two_or_more?.count || 0).toLocaleString()}</div>
            <div style={{ fontSize: 11, color: '#7a89b8' }}>2+ indicators ({overlap?.two_or_more?.pct || 0}%)</div>
          </div>
          <div style={{ flex: 1, background: 'white', border: '1px solid #e4e9f2', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#F44336' }}>{Number(overlap?.all_three?.count || 0).toLocaleString()}</div>
            <div style={{ fontSize: 11, color: '#7a89b8' }}>All 3 indicators ({overlap?.all_three?.pct || 0}%)</div>
          </div>
        </div>
      </div>
    </div>
  )
}
