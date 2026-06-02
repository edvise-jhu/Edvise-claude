import { useState, useEffect } from 'react'

const STATUS_OPTIONS = ['not_started', 'in_progress', 'completed', 'blocked']
const STATUS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked',
}
const STATUS_COLORS = {
  not_started: '#e4e9f2',
  in_progress: '#fdf3e1',
  completed: '#edf6f8',
  blocked: '#fff0f0',
}
const STATUS_TEXT = {
  not_started: '#7a89b8',
  in_progress: '#7a5c10',
  completed: '#1b6070',
  blocked: '#a32d2d',
}

export default function ActionPlanPanel({ data, onSave, onDiscard }) {
  const [plan, setPlan] = useState(data)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAck, setSavedAck] = useState(false)

  useEffect(() => {
    if (data) setPlan(data)
  }, [data])

  if (!plan) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#7a89b8', fontSize: 13 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <div style={{ fontWeight: 500, marginBottom: 6 }}>No data yet</div>
        <div>Upload a student data file and run analysis to generate an action plan.</div>
      </div>
    )
  }

  function updateAction(weekIdx, actionIdx, field, value) {
    setPlan((prev) => {
      const updated = JSON.parse(JSON.stringify(prev))
      updated.weeks[weekIdx].actions[actionIdx][field] = value
      return updated
    })
  }

  function patchAction(weekIdx, actionIdx, patch) {
    setPlan((prev) => {
      const updated = JSON.parse(JSON.stringify(prev))
      Object.assign(updated.weeks[weekIdx].actions[actionIdx], patch)
      return updated
    })
  }

  async function handleSave() {
    try {
      setSaving(true)
      const result = await onSave(plan)
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

  const allActions = plan.weeks.flatMap((w) => w.actions)
  const completed = allActions.filter((a) => a.status === 'completed' || a.done).length
  const total = allActions.length
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0

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
          }}
        >
          Saved to My Actions. You can open it from the sidebar under <strong>My Actions</strong> → Action plans.
        </div>
      )}
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid #e4e9f2',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{
              padding: '3px 8px',
              border: '1px solid #e4e9f2',
              borderRadius: 5,
              background: 'white',
              cursor: 'pointer',
              fontSize: 12,
              color: '#7a89b8',
            }}
          >
            B
          </button>
          <button
            type="button"
            style={{
              padding: '3px 8px',
              border: '1px solid #e4e9f2',
              borderRadius: 5,
              background: 'white',
              cursor: 'pointer',
              fontSize: 12,
              color: '#7a89b8',
              fontStyle: 'italic',
            }}
          >
            I
          </button>
        </div>
        <span style={{ fontSize: 11, color: '#7a89b8' }}>Auto-filled · edit freely</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: '#7a89b8',
              marginBottom: 4,
            }}
          >
            <span>Implementation progress</span>
            <span>
              {completed}/{total} actions · {pct}%
            </span>
          </div>
          <div style={{ height: 6, background: '#e4e9f2', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${pct}%`,
                background: '#3E94A5',
                borderRadius: 3,
                transition: 'width 0.3s',
              }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#7a89b8',
              marginBottom: 6,
            }}
          >
            Goal
          </div>
          <textarea
            value={plan.goal}
            onChange={(e) => setPlan((prev) => ({ ...prev, goal: e.target.value }))}
            style={{
              width: '100%',
              fontSize: 13,
              color: '#2A3B7C',
              border: 'none',
              resize: 'none',
              fontFamily: 'Inter, sans-serif',
              lineHeight: 1.6,
              outline: 'none',
              background: 'transparent',
              boxSizing: 'border-box',
            }}
            rows={3}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: '#7a89b8',
              marginBottom: 8,
            }}
          >
            Focus Group
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(plan.focus_group || []).map((chip, i) => (
              <span
                key={i}
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 500,
                  background: i === 0 ? '#fff0f0' : i === 1 ? '#fdf3e1' : '#f0f2f8',
                  color: i === 0 ? '#a32d2d' : i === 1 ? '#7a5c10' : '#2A3B7C',
                  border: `1px solid ${i === 0 ? '#f7c1c1' : i === 1 ? '#f5dfa0' : '#d4d9ee'}`,
                }}
              >
                {chip}
              </span>
            ))}
          </div>
        </div>

        {(plan.weeks || []).map((week, weekIdx) => (
          <div key={weekIdx} style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#2A3B7C', marginBottom: 2 }}>
              {week.week_label}
            </div>
            {week.theme && (
              <div style={{ fontSize: 11, color: '#7a89b8', marginBottom: 10 }}>{week.theme}</div>
            )}

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e4e9f2' }}>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#7a89b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      width: '30%',
                    }}
                  >
                    Action
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#7a89b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      width: '30%',
                    }}
                  >
                    Detail
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#7a89b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      width: '15%',
                    }}
                  >
                    Owner
                  </th>
                  <th
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#7a89b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      width: '15%',
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      textAlign: 'center',
                      padding: '6px 4px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#7a89b8',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      width: '10%',
                    }}
                  >
                    Done
                  </th>
                </tr>
              </thead>
              <tbody>
                {(week.actions || []).map((action, actionIdx) => (
                  <tr
                    key={action.id || actionIdx}
                    style={{ borderBottom: '1px solid #f5f5f5', opacity: action.done ? 0.5 : 1 }}
                  >
                    <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        style={{ fontWeight: 600, color: '#2A3B7C', outline: 'none', minHeight: 16 }}
                        onBlur={(e) =>
                          updateAction(weekIdx, actionIdx, 'action', e.target.innerText)
                        }
                      >
                        {action.action}
                      </div>
                    </td>
                    <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        style={{ color: '#7a89b8', outline: 'none', minHeight: 16, lineHeight: 1.5 }}
                        onBlur={(e) =>
                          updateAction(weekIdx, actionIdx, 'detail', e.target.innerText)
                        }
                      >
                        {action.detail}
                      </div>
                    </td>
                    <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                      <div
                        contentEditable
                        suppressContentEditableWarning
                        style={{ color: '#2A3B7C', outline: 'none', minHeight: 16 }}
                        onBlur={(e) =>
                          updateAction(weekIdx, actionIdx, 'owner', e.target.innerText)
                        }
                      >
                        {action.owner}
                      </div>
                    </td>
                    <td style={{ padding: '10px 8px', verticalAlign: 'top' }}>
                      <select
                        value={action.status || 'not_started'}
                        onChange={(e) =>
                          updateAction(weekIdx, actionIdx, 'status', e.target.value)
                        }
                        style={{
                          fontSize: 11,
                          padding: '3px 6px',
                          borderRadius: 12,
                          border: 'none',
                          fontFamily: 'Inter, sans-serif',
                          cursor: 'pointer',
                          background: STATUS_COLORS[action.status || 'not_started'],
                          color: STATUS_TEXT[action.status || 'not_started'],
                          outline: 'none',
                          width: '100%',
                        }}
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: '10px 4px', textAlign: 'center', verticalAlign: 'top' }}>
                      <input
                        type="checkbox"
                        checked={action.done || action.status === 'completed'}
                        onChange={(e) => {
                          const checked = e.target.checked
                          patchAction(weekIdx, actionIdx, {
                            done: checked,
                            status: checked ? 'completed' : 'not_started',
                          })
                        }}
                        style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#3E94A5' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button
              type="button"
              onClick={() => {
                setPlan((prev) => {
                  const updated = JSON.parse(JSON.stringify(prev))
                  updated.weeks[weekIdx].actions.push({
                    id: `w${weekIdx + 1}_${Date.now()}`,
                    action: 'New action',
                    detail: '',
                    owner: '',
                    status: 'not_started',
                    done: false,
                  })
                  return updated
                })
              }}
              style={{
                marginTop: 6,
                fontSize: 11,
                color: '#3E94A5',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
                fontFamily: 'Inter, sans-serif',
              }}
            >
              + Add action
            </button>
          </div>
        ))}
      </div>

      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid #e4e9f2',
          display: 'flex',
          gap: 8,
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
            transition: 'all 0.2s',
            opacity: saving ? 0.85 : 1,
          }}
        >
          {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save to My actions'}
        </button>
      </div>
    </div>
  )
}
