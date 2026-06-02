import { useEffect, useState } from 'react'

export default function MeetingAgenda({ data, onSave, onDiscard }) {
  const [agenda, setAgenda] = useState(data)
  const [isEditing, setIsEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  useEffect(() => {
    setAgenda(data)
    setIsEditing(false)
  }, [data])

  if (!data) return null

  async function handleSave() {
    if (!onSave) return
    try {
      setSaving(true)
      const result = await onSave(agenda)
      console.log('Save result:', result)
      setSaved(true)
      setSavedAck(true)
      setTimeout(() => setSaved(false), 2000)
      setTimeout(() => setSavedAck(false), 8000)
    } catch (e) {
      console.error('Save failed:', e)
      alert('Save failed: ' + (e?.message || String(e)))
    } finally {
      setSaving(false)
    }
  }

  function updateField(field, value) {
    setAgenda((prev) => ({ ...(prev || {}), [field]: value }))
  }

  function updateItem(idx, field, value) {
    setAgenda((prev) => {
      const next = { ...(prev || {}) }
      const items = Array.isArray(next.items) ? [...next.items] : []
      items[idx] = { ...(items[idx] || {}), [field]: value }
      next.items = items
      return next
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {savedAck && (
        <div
          role="status"
          style={{
            padding: '10px 16px',
            background: '#edf6f8',
            borderBottom: '1px solid #b8dde6',
            fontSize: 12,
            color: '#1b6070',
            lineHeight: 1.45,
            flexShrink: 0,
          }}
        >
          Saved to My Actions. You can open it from the sidebar under <strong>My Actions</strong> → Meeting agendas.
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 4px 12px 0' }}>
        {onSave && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setIsEditing((v) => !v)}
              style={{
                padding: '6px 10px',
                border: '1px solid #e4e9f2',
                borderRadius: 8,
                background: isEditing ? '#edf6f8' : 'white',
                color: isEditing ? '#1b6070' : '#7a89b8',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              {isEditing ? 'Done editing' : 'Edit'}
            </button>
          </div>
        )}
        <div className="ap-label">Meeting</div>
        {isEditing ? (
          <input
            value={agenda?.title || ''}
            onChange={(e) => updateField('title', e.target.value)}
            style={{ width: '100%', fontWeight: 600, color: 'var(--text)', fontSize: 14, border: '1px solid #e4e9f2', borderRadius: 8, padding: '8px 10px', fontFamily: 'inherit' }}
          />
        ) : (
          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>{agenda?.title}</div>
        )}
        {(agenda?.date_suggestion || agenda?.duration_minutes || agenda?.location) && (
          <div className="agenda-meta">
            {isEditing ? (
              <>
                <input
                  value={agenda?.date_suggestion || ''}
                  onChange={(e) => updateField('date_suggestion', e.target.value)}
                  placeholder="Date"
                  style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 8px', fontSize: 12, marginRight: 6 }}
                />
                <input
                  value={agenda?.duration_minutes ?? ''}
                  onChange={(e) => updateField('duration_minutes', e.target.value)}
                  placeholder="Duration (min)"
                  style={{ width: 110, border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 8px', fontSize: 12, marginRight: 6 }}
                />
                <input
                  value={agenda?.location || ''}
                  onChange={(e) => updateField('location', e.target.value)}
                  placeholder="Location"
                  style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 8px', fontSize: 12 }}
                />
              </>
            ) : (
              <>
                {agenda?.date_suggestion}
                {agenda?.duration_minutes ? ` · ${agenda.duration_minutes} min` : ''}
                {agenda?.location ? ` · ${agenda.location}` : ''}
              </>
            )}
          </div>
        )}

        {(agenda?.purpose != null) && (
          <>
            <div className="ap-label">Purpose</div>
            {isEditing ? (
              <textarea
                value={agenda?.purpose || ''}
                onChange={(e) => updateField('purpose', e.target.value)}
                rows={3}
                style={{ width: '100%', fontSize: 12, color: 'var(--text)', lineHeight: 1.55, border: '1px solid #e4e9f2', borderRadius: 8, padding: '8px 10px', resize: 'vertical', fontFamily: 'inherit' }}
              />
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.55 }}>{agenda?.purpose}</div>
            )}
          </>
        )}

        {agenda?.attendees_placeholder && agenda.attendees_placeholder.length > 0 && (
          <>
            <div className="ap-label">Attendees</div>
            <div className="chip-row">
              {agenda.attendees_placeholder.map((a, i) => (
                <span key={i} className="chip chip-teal">{a}</span>
              ))}
            </div>
          </>
        )}

        {agenda?.items && agenda.items.length > 0 && (
          <>
            <div className="ap-label">Agenda Items</div>
            {agenda.items.map((item, i) => (
              <div key={i} className="agenda-row">
                {isEditing ? (
                  <input
                    value={item.time || ''}
                    onChange={(e) => updateItem(i, 'time', e.target.value)}
                    className="agenda-time"
                    style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 6px', width: 60 }}
                  />
                ) : (
                  <div className="agenda-time">{item.time}</div>
                )}
                <div>
                  {isEditing ? (
                    <>
                      <input
                        value={item.title || ''}
                        onChange={(e) => updateItem(i, 'title', e.target.value)}
                        className="agenda-item-name"
                        style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 8px', width: '100%', marginBottom: 6 }}
                      />
                      <textarea
                        value={item.detail || ''}
                        onChange={(e) => updateItem(i, 'detail', e.target.value)}
                        className="agenda-item-detail"
                        rows={2}
                        style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '6px 8px', width: '100%', resize: 'vertical' }}
                      />
                      <input
                        value={item.lead || ''}
                        onChange={(e) => updateItem(i, 'lead', e.target.value)}
                        className="agenda-item-detail"
                        placeholder="Lead"
                        style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 8px', marginTop: 6, width: '100%' }}
                      />
                    </>
                  ) : (
                    <>
                      <div className="agenda-item-name">{item.title}</div>
                      {item.detail && <div className="agenda-item-detail">{item.detail}</div>}
                      {item.lead && <div className="agenda-item-detail">Lead: {item.lead}</div>}
                    </>
                  )}
                </div>
                {isEditing ? (
                  <input
                    value={item.duration_min ?? ''}
                    onChange={(e) => updateItem(i, 'duration_min', e.target.value)}
                    className="agenda-duration"
                    style={{ border: '1px solid #e4e9f2', borderRadius: 6, padding: '4px 6px', width: 52 }}
                  />
                ) : (
                  <div className="agenda-duration">{item.duration_min}m</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {onSave && (
        <div
          style={{
            padding: '12px 0 0 0',
            borderTop: '1px solid #e4e9f2',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={onDiscard}
            style={{
              flex: 1,
              padding: '9px 0',
              border: '1px solid #e4e9f2',
              borderRadius: 8,
              background: 'white',
              fontSize: 13,
              color: '#7a89b8',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 2,
              padding: '9px 0',
              border: '1px solid #EFB340',
              borderRadius: 8,
              background: saved ? '#3E94A5' : 'white',
              fontSize: 13,
              fontWeight: 500,
              color: saved ? 'white' : '#EFB340',
              cursor: saving ? 'wait' : 'pointer',
              fontFamily: 'Inter, sans-serif',
              opacity: saving ? 0.85 : 1,
            }}
          >
            {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save to My actions'}
          </button>
        </div>
      )}
    </div>
  )
}
