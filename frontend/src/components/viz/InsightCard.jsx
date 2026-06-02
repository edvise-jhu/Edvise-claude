import { InsightStrips, NextActions } from './shared'

export default function InsightCard({ data, onAction }) {
  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, padding: 12, marginTop: 10, background: '#fff' }}>
      <div style={{ fontWeight: 600, color: '#2A3B7C' }}>{data?.title || 'Insight'}</div>
      {data?.summary && <div style={{ fontSize: 12, color: '#445', marginTop: 6 }}>{data.summary}</div>}
      <InsightStrips insights={data?.insights} />
      <NextActions actions={data?.next_actions} onAction={onAction} />
    </div>
  )
}
