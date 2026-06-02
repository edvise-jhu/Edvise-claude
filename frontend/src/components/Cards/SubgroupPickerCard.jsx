import { useState } from 'react'

export default function SubgroupPickerCard({ data, onConfirm }) {
  const [checked, setChecked] = useState(
    () => Object.fromEntries((data.groups || []).map((g) => [g.key, true])),
  )
  const [confirmed, setConfirmed] = useState(false)

  function toggle(key) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function handleConfirm() {
    setConfirmed(true)
    onConfirm((data.groups || []).filter((g) => checked[g.key]).map((g) => g.key))
  }

  if (confirmed) {
    const selected = (data.groups || []).filter((g) => checked[g.key])
    return (
      <div style={{ border: '1px solid #e4e9f2', borderRadius: 10, padding: '10px 14px', background: '#f7f9fc', fontSize: 12 }}>
        <span style={{ fontWeight: 600, color: '#2A3B7C' }}>✓ Subgroups confirmed — </span>
        <span style={{ color: '#7a89b8' }}>{selected.map((g) => g.label).join(', ')}</span>
      </div>
    )
  }

  return (
    <div className="data-confirm">
      <div className="data-confirm-header">Subgroup analysis — select groups to include</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Uncheck any groups you don&apos;t want in this analysis.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {(data.groups || []).map((g) => (
          <label
            key={g.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              border: '1px solid #e4e9f2',
              borderRadius: 8,
              cursor: 'pointer',
              background: checked[g.key] ? '#f0f8fa' : 'white',
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(checked[g.key])}
              onChange={() => toggle(g.key)}
              style={{ accentColor: '#3E94A5', width: 15, height: 15 }}
            />
            <span style={{ fontSize: 12, fontWeight: 500, color: '#2A3B7C', flex: 1 }}>{g.label}</span>
            {g.n != null && g.n !== '' && <span style={{ fontSize: 11, color: '#7a89b8' }}>{g.n} students</span>}
          </label>
        ))}
      </div>
      <div className="data-confirm-footer">
        <button type="button" className="sc-btn primary" onClick={handleConfirm}>
          Run subgroup analysis →
        </button>
      </div>
    </div>
  )
}
