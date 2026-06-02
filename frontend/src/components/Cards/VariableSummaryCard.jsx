import { useState } from 'react'

export default function VariableSummaryCard({ data, onConfirmed }) {
  const { variableRows = [], columnMetadata = {}, mapping = {} } = data

  const [columnState, setColumnState] = useState(() => {
    const out = {}
    variableRows.forEach(row => {
      const meta = columnMetadata[row.col] || {}
      out[row.col] = {
        suggestedName: meta.label || row.label || row.col,
        enabled: true,
        confidence: meta.confidence || 'high',
      }
    })
    return out
  })

  const [confirmed, setConfirmed] = useState(false)

  function toggleColumn(col) {
    setColumnState(prev => ({
      ...prev,
      [col]: { ...prev[col], enabled: !prev[col].enabled },
    }))
  }

  function updateName(col, newName) {
    setColumnState(prev => ({
      ...prev,
      [col]: { ...prev[col], suggestedName: newName },
    }))
  }

  function handleConfirm() {
    setConfirmed(true)

    const enabledCols = new Set(
      variableRows.filter(r => columnState[r.col]?.enabled).map(r => r.col)
    )
    const aliases = {}
    variableRows.forEach(row => {
      const original = row.label || row.col
      const edited = columnState[row.col]?.suggestedName
      if (edited && edited !== original) aliases[row.col] = edited
    })

    let finalMapping = { ...mapping }

    if (Array.isArray(finalMapping.sel_factors)) {
      finalMapping.sel_factors = finalMapping.sel_factors.filter(c => enabledCols.has(c))
    }

    if (Object.keys(aliases).length) {
      finalMapping.column_aliases = aliases
    }

    onConfirmed(finalMapping)
  }

  if (confirmed) {
    return (
      <div style={{
        border: '1px solid #e4e9f2',
        borderRadius: 10,
        padding: '10px 14px',
        background: '#f7f9fc',
        fontSize: 12,
      }}>
        <div style={{ fontWeight: 600, color: '#2A3B7C', fontSize: 11 }}>✓ Starting analysis…</div>
      </div>
    )
  }

  const needsReview = variableRows.filter(r =>
    columnState[r.col]?.confidence === 'low' || columnState[r.col]?.confidence === 'medium'
  )

  return (
    <div className="data-confirm">
      <div className="data-confirm-header">
        {data.stageTitle || 'Variables used in this analysis'}
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        {data.stageDesc || 'Review the columns EdVise will use. Edit names or toggle off any you want to exclude.'}
      </p>

      {needsReview.length > 0 && (
        <div style={{
          background: '#fff8e1',
          border: '1px solid #ffe082',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 11,
          color: '#795548',
          marginBottom: 12,
        }}>
          ⚠ {needsReview.length} column{needsReview.length > 1 ? 's' : ''} need your review
        </div>
      )}

      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 60px',
        gap: 8,
        padding: '6px 8px',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
        marginBottom: 4,
      }}>
        <span>Original column name</span>
        <span>Suggested name (editable)</span>
        <span style={{ textAlign: 'center' }}>Include</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 16 }}>
        {variableRows.map(row => {
          const state = columnState[row.col] || {}
          const needsCheck = state.confidence === 'low' || state.confidence === 'medium'

          return (
            <div
              key={row.col}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 60px',
                gap: 8,
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 6,
                background: needsCheck ? '#fff8e1' : 'transparent',
                opacity: state.enabled ? 1 : 0.4,
              }}
            >
              {/* Original column name */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: 'var(--text)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '2px 6px',
                }}>
                  {row.col}
                </span>
                {needsCheck && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 10,
                    background: '#ffe082',
                    color: '#795548',
                    whiteSpace: 'nowrap',
                  }}>
                    Review
                  </span>
                )}
              </div>

              {/* Editable suggested name */}
              <input
                type="text"
                value={state.suggestedName || ''}
                onChange={e => updateName(row.col, e.target.value)}
                disabled={!state.enabled}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  padding: '4px 8px',
                  fontSize: 12,
                  color: 'var(--text)',
                  background: 'var(--bg)',
                  outline: 'none',
                  width: '100%',
                }}
              />

              {/* Toggle */}
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                  type="button"
                  onClick={() => toggleColumn(row.col)}
                  style={{
                    width: 36,
                    height: 20,
                    borderRadius: 10,
                    border: 'none',
                    background: state.enabled ? '#3E94A5' : '#d0d5e8',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'background 0.2s',
                  }}
                >
                  <span style={{
                    position: 'absolute',
                    top: 2,
                    left: state.enabled ? 18 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'white',
                    transition: 'left 0.2s',
                  }} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="data-confirm-footer">
        <button type="button" className="sc-btn primary" onClick={handleConfirm}>
          {data.intent === 'sel' ? 'Run SEL Analysis →' : 'Looks good — start analysis →'}
        </button>
      </div>
    </div>
  )
}
