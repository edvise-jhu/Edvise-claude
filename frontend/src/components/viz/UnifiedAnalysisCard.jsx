import { NextActions } from './shared'

export default function UnifiedAnalysisCard({ data, onAction }) {
  const indicators = Array.isArray(data?.indicators) ? data.indicators : []
  const total      = Number(data?.summary?.total_students || 0)
  const flagged    = Number(data?.summary?.total_flagged  || 0)
  const flaggedPct = Number(data?.summary?.flagged_pct    || 0)
  const noFlags    = total - flagged

  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, overflow: 'hidden', marginTop: 10, background: '#fff' }}>

      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid #e4e9f2', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontWeight: 700, color: '#2A3B7C' }}>{data?.title || 'School overview'}</div>
        <div style={{ fontSize: 12, color: '#7a89b8' }}>
          {total.toLocaleString()} students · {flagged.toLocaleString()} flagged ({flaggedPct}%)
        </div>
      </div>

      <div style={{ padding: 12 }}>

        {/* Summary tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
          {[
            { label: 'Total students', val: total,     sub: 'enrolled',                                                          color: '#2A3B7C' },
            { label: 'Any flag',       val: flagged,   sub: `${flaggedPct}% of school`,                                          color: '#b7791f' },
            { label: 'All 3 flags',    val: Number(data?.overlap?.all_three?.count || 0),
              sub: `${Number(data?.overlap?.all_three?.pct || 0)}% of school`,                                                    color: '#c53030' },
            { label: 'No flags',       val: noFlags,   sub: `${total > 0 ? Math.round((noFlags / total) * 100) : 0}% of school`, color: '#276749' },
          ].map((t, i) => (
            <div key={i} style={{ background: '#f7f9fc', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 10, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{t.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: t.color }}>{t.val.toLocaleString()}</div>
              <div style={{ fontSize: 10, color: '#7a89b8', marginTop: 2 }}>{t.sub}</div>
            </div>
          ))}
        </div>

        {data?.summary?.highlight_metric && (
          <div style={{ fontSize: 12, color: '#7a89b8', marginBottom: 12 }}>{data.summary.highlight_metric}</div>
        )}

        {indicators.length > 0 && (
          <div style={{ border: '1px solid #f0f3fa', borderRadius: 10, padding: 10, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Risk indicators — school-wide
            </div>
            {indicators.map((it, i) => (
              <div key={i} style={{ marginBottom: i < indicators.length - 1 ? 12 : 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                  <span style={{ fontWeight: 600, color: it.color || '#2A3B7C' }}>{it.name}</span>
                  <span style={{ fontWeight: 700, color: it.color || '#2A3B7C' }}>
                    {Number(it.count || 0).toLocaleString()} ({it.pct_of_total || 0}%)
                  </span>
                </div>
                <div style={{ height: 7, background: '#eef2f8', borderRadius: 999 }}>
                  <div style={{
                    width: `${Math.min(100, Number(it.pct_of_total || 0))}%`,
                    height: '100%', borderRadius: 999,
                    background: it.color || '#3E94A5', opacity: 0.85,
                  }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {data?.overlap && (
          <div style={{ border: '1px solid #f0f3fa', borderRadius: 10, padding: 10, marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              Flag combinations
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              <div style={{ background: '#fffbeb', border: '1px solid #fbd38d', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, color: '#b7791f', marginBottom: 3 }}>2 or more flags</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#b7791f' }}>{Number(data.overlap.two_or_more?.count || 0)}</div>
                <div style={{ fontSize: 10, color: '#b7791f' }}>{Number(data.overlap.two_or_more?.pct || 0)}% of school</div>
              </div>
              <div style={{ background: '#fff5f5', border: '1px solid #fed7d7', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ fontSize: 11, color: '#c53030', marginBottom: 3 }}>All 3 flags</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#c53030' }}>{Number(data.overlap.all_three?.count || 0)}</div>
                <div style={{ fontSize: 10, color: '#c53030' }}>{Number(data.overlap.all_three?.pct || 0)}% of school</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {[
                { label: 'Absence only',          key: 'absent_only' },
                { label: 'Behavior only',         key: 'behavior_only' },
                { label: 'Academic failure only', key: 'academic_only' },
                { label: 'Absence + Academic',    key: 'absent_academic' },
                { label: 'Absence + Behavior',    key: 'absent_behavior' },
                { label: 'Behavior + Academic',   key: 'behavior_academic' },
              ].filter(({ key }) => (data.overlap.combinations?.[key] || 0) > 0)
               .map(({ label, key }) => (
                <div key={key} style={{ fontSize: 12, color: '#4a5568', display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid #f0f3fa' }}>
                  <span>{label}</span>
                  <span style={{ fontWeight: 600, color: '#2A3B7C' }}>{data.overlap.combinations[key]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <NextActions
          actions={[
            'View grade breakdown →',
            'Run subgroup analysis →',
            'Show me students with all 3 flags',
          ]}
          onAction={onAction}
        />
      </div>
    </div>
  )
}
