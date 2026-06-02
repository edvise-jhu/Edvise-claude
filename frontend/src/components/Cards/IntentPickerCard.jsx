/**
 * IntentPickerCard
 *
 * Shown after the teacher uploads a CSV directly (without clicking a starter card),
 * so we don't know what they want to do yet.
 *
 * Props:
 *   data.options  — [{ title, desc, intent }]
 *   onSelect(intent) — called when teacher picks an option
 */
export default function IntentPickerCard({ data, onSelect }) {
  if (!data) return null
  const { options = [] } = data

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 12,
      overflow: 'hidden',
      maxWidth: 480,
      background: 'var(--surface)',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text)',
      }}>
        What would you like to do with this data?
      </div>

      <div style={{ padding: '8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {options.map((opt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSelect?.(opt.intent)}
            style={{
              textAlign: 'left',
              padding: '14px 16px',
              border: '1px solid var(--border)',
              borderRadius: 10,
              background: 'var(--bg)',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--accent-light, #edf7f9)'
              e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'var(--bg)'
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
              {opt.title}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {opt.desc}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
