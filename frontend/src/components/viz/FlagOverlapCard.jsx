import { InsightStrips, NextActions } from './shared'

export default function FlagOverlapCard({ data, onAction }) {
  const rows = Array.isArray(data?.rows) ? data.rows : []
  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, padding: 12, marginTop: 10, background: '#fff' }}>
      <div style={{ fontWeight: 600, color: '#2A3B7C' }}>{data?.title || 'Flag overlap'}</div>
      <div style={{ fontSize: 12, color: '#7a89b8', marginTop: 4 }}>At-risk total: {data?.total_atrisk ?? data?.total_atrisk}</div>
      <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span>{Array.isArray(r.flags) ? r.flags.join(' + ') : ''}</span>
            <span>{r.count} ({r.pct}%)</span>
          </div>
        ))}
      </div>
      <InsightStrips insights={data?.insights} />
      <NextActions actions={data?.next_actions} onAction={onAction} />
    </div>
  )
}
