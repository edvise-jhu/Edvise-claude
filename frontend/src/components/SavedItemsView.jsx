import { useState, useEffect } from 'react'
import { listArtifacts, saveArtifact } from '../lib/api'
import ActionPlanPanel from './ArtifactPanel/ActionPlanPanel'
import MeetingAgenda from './ArtifactPanel/MeetingAgenda'
import Report from './ArtifactPanel/Report'

export default function SavedItemsView({ type, title, accessToken = null, refreshKey = 0 }) {
  const [items, setItems] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const data = await listArtifacts(type, accessToken)
        if (!cancelled) setItems(Array.isArray(data) ? data : [])
      } catch (e) {
        console.error(e)
      }
      if (!cancelled) setLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [type, accessToken, refreshKey])

  if (selected) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '0 32px 32px' }}>
        <button
          type="button"
          onClick={() => setSelected(null)}
          style={{
            fontSize: 12,
            color: '#3E94A5',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'Inter',
            margin: '20px 0',
            padding: 0,
            display: 'block',
          }}
        >
          ← Back to {title}
        </button>

        <div style={{ fontSize: 13, color: '#7a89b8', marginBottom: 20 }}>
          Saved{' '}
          {new Date(selected.created_at).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </div>

        {type === 'action_plan' && (
          <ActionPlanPanel
            key={selected.id}
            data={selected.data}
            onSave={async (updated) => {
              const row = await saveArtifact(type, updated, null, accessToken, selected.id)
              setSelected((prev) => ({
                ...prev,
                data: updated,
                ...(row?.title != null ? { title: row.title } : {}),
              }))
            }}
            onDiscard={() => setSelected(null)}
          />
        )}

        {type === 'agenda' && (
          <MeetingAgenda
            key={selected.id}
            data={selected.data}
            onSave={async (updated) => {
              const row = await saveArtifact(type, updated, null, accessToken, selected.id)
              setSelected((prev) => ({
                ...prev,
                data: updated,
                ...(row?.title != null ? { title: row.title } : {}),
              }))
            }}
            onDiscard={() => setSelected(null)}
          />
        )}

        {type === 'report' && (
          <Report
            key={selected.id}
            data={selected.data}
            onSave={async (updated) => {
              const row = await saveArtifact(type, updated, null, accessToken, selected.id)
              setSelected((prev) => ({
                ...prev,
                data: updated,
                ...(row?.title != null ? { title: row.title } : {}),
              }))
            }}
            onDiscard={() => setSelected(null)}
          />
        )}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 32 }}>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#2A3B7C', marginBottom: 24 }}>{title}</div>

      {loading ? (
        <div style={{ fontSize: 13, color: '#7a89b8' }}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 13, color: '#7a89b8', textAlign: 'center', paddingTop: 60 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>
            {type === 'action_plan' ? '📋' : type === 'agenda' ? '📅' : '📊'}
          </div>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>No {title.toLowerCase()} yet</div>
          <div>Generate one from a conversation and click Save to My Actions</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(item)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setSelected(item)
              }}
              style={{
                padding: '14px 16px',
                border: '1px solid #e4e9f2',
                borderRadius: 10,
                cursor: 'pointer',
                background: 'white',
                transition: 'border-color 0.1s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#3E94A5'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#e4e9f2'
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500, color: '#2A3B7C', marginBottom: 4 }}>
                {item.title || 'Untitled'}
              </div>
              <div style={{ fontSize: 11, color: '#7a89b8' }}>
                {new Date(item.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
