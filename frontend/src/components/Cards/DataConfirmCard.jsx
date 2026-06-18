import { useState } from 'react'
import { confirmVariableNames } from '../../lib/api'

export default function DataConfirmCard({ data, onConfirm }) {
  if (!data || !data.columns) return null

  const allCols = data.columns || []
  const metadata = data.column_metadata || {}
  const fileId = data.file_id

  const [columnState, setColumnState] = useState(() => {
    const out = {}
    allCols.forEach(col => {
      const meta = metadata[col] || {}
      out[col] = {
        suggestedName: meta.label || col,
        enabled: meta.role !== 'ignore',
        confidence: meta.confidence || 'high',
        description: meta.description || '',
      }
    })
    return out
  })

  const [isConfirming, setIsConfirming] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [confirmedMapping, setConfirmedMapping] = useState(null)

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

  async function handleConfirm() {
    setIsConfirming(true)
    try {
      const confirmedNames = {}
      const disabledColumns = []
      allCols.forEach(col => {
        if (columnState[col].enabled) {
          confirmedNames[col] = columnState[col].suggestedName
        } else {
          disabledColumns.push(col)
        }
      })

      const result = await confirmVariableNames(fileId, confirmedNames)
      setConfirmedMapping(result.suggested_mapping)
      setConfirmed(true)
      onConfirm(result.suggested_mapping, result.column_metadata, disabledColumns)
    } catch (e) {
      console.error('confirmVariableNames failed:', e)
      onConfirm(data.suggested_mapping, metadata, [])
    } finally {
      setIsConfirming(false)
    }
  }

  if (confirmed && confirmedMapping) {
    const enabledCount = allCols.filter(c => columnState[c]?.enabled).length
    return (
      <div style={{
        border: '1px solid #e4e9f2',
        borderRadius: 10,
        padding: '10px 14px',
        background: '#f7f9fc',
        fontSize: 12,
      }}>
        <div style={{ fontWeight: 600, color: '#2A3B7C', marginBottom: 4, fontSize: 11 }}>
          ✓ Variables confirmed — {data.filename} ({data.rows} students)
        </div>
        <div style={{ fontSize: 11, color: '#7a89b8' }}>
          {enabledCount} of {allCols.length} columns included in analysis
        </div>
      </div>
    )
  }

  const needsReview = allCols.filter(c =>
    columnState[c]?.confidence === 'low' || columnState[c]?.confidence === 'medium'
  )

  return (
    <div className="data-confirm">
      <div className="data-confirm-header">
        Variable mapping — {data.filename} ({data.rows} students)
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Claude has suggested a name for each column. Edit any names that are wrong,
        toggle off columns you don&apos;t need, then confirm.
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
          — Claude wasn&apos;t confident about these. Check that the suggested names are correct.
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

      {/* Column rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 16 }}>
        {allCols.map(col => {
          const state = columnState[col] || {}
          const needsCheck = state.confidence === 'low' || state.confidence === 'medium'

          return (
            <div
              key={col}
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
                  {col}
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
                onChange={e => updateName(col, e.target.value)}
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
                  onClick={() => toggleColumn(col)}
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

      {/* Preview */}
      {data.preview && (
        <div style={{
          padding: '8px 14px',
          overflowX: 'auto',
          borderTop: '1px solid var(--border)',
          marginBottom: 12,
        }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--text-muted)',
            marginBottom: 6,
          }}>
            Preview (first 3 rows)
          </div>
          <table style={{ fontSize: 11, borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {allCols.slice(0, 7).map(col => (
                  <th key={col} style={{
                    padding: '3px 8px',
                    textAlign: 'left',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {columnState[col]?.suggestedName || col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.preview.map((row, i) => (
                <tr key={i}>
                  {allCols.slice(0, 7).map(col => (
                    <td key={col} style={{
                      padding: '3px 8px',
                      color: 'var(--text)',
                      whiteSpace: 'nowrap',
                    }}>
                      {String(row[col] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="data-confirm-footer">
        <button
          type="button"
          className="sc-btn primary"
          onClick={handleConfirm}
          disabled={isConfirming}
        >
          {isConfirming ? 'Mapping variables…' : 'Confirm & Continue →'}
        </button>
      </div>
    </div>
  )
}
