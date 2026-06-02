import { NextActions } from './shared'

export default function StudentTableCard({ data, onAction }) {
  const columns = Array.isArray(data?.columns) ? data.columns : []
  const rows = Array.isArray(data?.rows) ? data.rows : []
  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, padding: 12, marginTop: 10, background: '#fff', overflowX: 'auto' }}>
      <div style={{ fontWeight: 600, color: '#2A3B7C' }}>{data?.title || 'Student list'}</div>
      {data?.filter_description && <div style={{ fontSize: 12, color: '#7a89b8', marginTop: 4 }}>{data.filter_description}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12 }}>
        <thead>
          <tr>{columns.map((c) => <th key={c} style={{ textAlign: 'left', borderBottom: '1px solid #e4e9f2', padding: '6px 4px' }}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{columns.map((c) => <td key={c} style={{ borderBottom: '1px solid #f2f4f8', padding: '6px 4px' }}>{String(r?.[c] ?? '')}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <NextActions actions={data?.next_actions} onAction={onAction} />
    </div>
  )
}
