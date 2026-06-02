import { useEffect, useState } from 'react'
import ArtifactRenderer from '../ArtifactRenderer'

export default function Report({ data, onSave, onDiscard }) {
  const [draft, setDraft] = useState(() => data || {})
  const [isEditing, setIsEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  if (!data) return null

  useEffect(() => {
    setDraft(data || {})
    setIsEditing(false)
  }, [data])

  async function handleSave() {
    if (!onSave) return
    try {
      setSaving(true)
      const result = await onSave(draft)
      console.log('Save result:', result)
      setSaved(true)
      setSavedAck(true)
      setIsEditing(false)
      setTimeout(() => setSaved(false), 2000)
      setTimeout(() => setSavedAck(false), 8000)
    } catch (e) {
      console.error('Save failed:', e)
      alert('Save failed: ' + (e?.message || String(e)))
    } finally {
      setSaving(false)
    }
  }

  function BulletList({ items }) {
    if (!items || items.length === 0) return null
    return (
      <ul style={{ paddingLeft: 16, margin: 0 }}>
        {items.map((item, i) => (
          <li key={i} style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6, marginBottom: 4 }}>{item}</li>
        ))}
      </ul>
    )
  }

  function listToText(items) {
    if (!Array.isArray(items)) return ''
    return items.join('\n')
  }

  function textToList(text) {
    return String(text || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  function VisualizationSection({ items }) {
    if (!Array.isArray(items) || items.length === 0) return null
    return (
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        {items.map((item, i) => {
          const label = item?.title || item?.type?.replace(/_/g, ' ') || 'Visualization'
          const isDynamic = item?.type === 'dynamic_artifact'
          return (
            <div
              key={`${item?.type || 'viz'}-${i}`}
              style={{
                marginBottom: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                overflow: 'hidden',
                background: 'var(--card)',
              }}
            >
              <div style={{ padding: '8px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {label}
              </div>
              <div style={{ padding: 10 }}>
                {isDynamic ? (
                  <ArtifactRenderer artifact={item} />
                ) : item?.imageUrl ? (
                  <img src={item.imageUrl} alt={label} style={{ width: '100%', borderRadius: 6 }} />
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Saved with report for reference.</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
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
          Saved to My Actions. You can open it from the sidebar under <strong>My Actions</strong> → Reports.
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 4px 12px 0' }}>
        {isEditing ? (
          <input
            value={draft.title || ''}
            onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
            placeholder="Report title"
            style={{ width: '100%', marginBottom: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}
          />
        ) : (
          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14, marginBottom: 4 }}>{draft.title}</div>
        )}

        {(isEditing || draft.summary) && (
          <>
            <div className="ap-label">Summary</div>
            {isEditing ? (
              <textarea
                value={draft.summary || ''}
                onChange={(e) => setDraft((prev) => ({ ...prev, summary: e.target.value }))}
                rows={4}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <div className="ap-goal">{draft.summary}</div>
            )}
          </>
        )}

        {(isEditing || (draft.key_findings && draft.key_findings.length > 0)) && (
          <>
            <div className="ap-label">Key Findings</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.key_findings)}
                onChange={(e) => setDraft((prev) => ({ ...prev, key_findings: textToList(e.target.value) }))}
                rows={6}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.key_findings} />
            )}
          </>
        )}

        {(isEditing || (draft.recommendations && draft.recommendations.length > 0)) && (
          <>
            <div className="ap-label">Recommendations</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.recommendations)}
                onChange={(e) => setDraft((prev) => ({ ...prev, recommendations: textToList(e.target.value) }))}
                rows={6}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.recommendations} />
            )}
          </>
        )}

        {(isEditing || (draft.next_steps && draft.next_steps.length > 0)) && (
          <>
            <div className="ap-label">Next Steps</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.next_steps)}
                onChange={(e) => setDraft((prev) => ({ ...prev, next_steps: textToList(e.target.value) }))}
                rows={4}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.next_steps} />
            )}
          </>
        )}

        {(isEditing || (draft.conversation_summary && draft.conversation_summary.length > 0)) && (
          <>
            <div className="ap-label">Conversation Summary</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.conversation_summary)}
                onChange={(e) => setDraft((prev) => ({ ...prev, conversation_summary: textToList(e.target.value) }))}
                rows={6}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.conversation_summary} />
            )}
          </>
        )}

        {(isEditing || (draft.visualizations_used && draft.visualizations_used.length > 0)) && (
          <>
            <div className="ap-label">Charts & Graphs Used</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.visualizations_used)}
                onChange={(e) => setDraft((prev) => ({ ...prev, visualizations_used: textToList(e.target.value) }))}
                rows={5}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.visualizations_used} />
            )}
          </>
        )}

        {(isEditing || (draft.tables_used && draft.tables_used.length > 0)) && (
          <>
            <div className="ap-label">Tables Used</div>
            {isEditing ? (
              <textarea
                value={listToText(draft.tables_used)}
                onChange={(e) => setDraft((prev) => ({ ...prev, tables_used: textToList(e.target.value) }))}
                rows={5}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}
              />
            ) : (
              <BulletList items={draft.tables_used} />
            )}
          </>
        )}

        {!isEditing && Array.isArray(draft.visualizations) && draft.visualizations.length > 0 && (
          <>
            <div className="ap-label">Visualizations</div>
            <VisualizationSection items={draft.visualizations} />
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
            onClick={() => setIsEditing((v) => !v)}
            style={{
              flex: 1,
              padding: '9px 0',
              border: '1px solid #e4e9f2',
              borderRadius: 8,
              background: 'white',
              fontSize: 13,
              color: '#3E94A5',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            {isEditing ? 'Done editing' : 'Edit'}
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
