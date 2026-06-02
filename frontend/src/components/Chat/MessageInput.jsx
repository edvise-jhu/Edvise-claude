import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { openGooglePicker, downloadDriveFile } from '../../lib/googlePicker'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

function PendingApprovalChip() {
  const [count, setCount] = useState(0)

  useEffect(() => {
    async function fetchPending() {
      try {
        const token = localStorage.getItem('edvise_token')
        const res = await fetch(`${API_URL}/knowledge/pending-count`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        const data = await res.json()
        setCount(data.count || 0)
      } catch {
        // ignore
      }
    }
    fetchPending()
  }, [])

  if (count === 0) return null

  return (
    <span style={{
      padding: '3px 10px',
      borderRadius: 20,
      border: '1px solid #f7c1c1',
      fontSize: 11,
      fontWeight: 500,
      background: '#fff3f3',
      color: '#a32d2d',
    }}>
      ● {count} doc{count !== 1 ? 's' : ''} pending approval
    </span>
  )
}

function CsvPreviewTable({ fileData }) {
  const [rows, setRows] = useState([])
  const [cols, setCols] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const token = localStorage.getItem('edvise_token')
        const res = await fetch(
          `${API_URL}/analysis/preview?file_id=${fileData.file_id}&rows=50`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} }
        )
        const data = await res.json()
        setCols(data.columns || [])
        setRows(data.rows || [])
      } catch {
        setRows([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [fileData.file_id])

  if (loading) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#7a89b8', fontSize: 12 }}>
      Loading preview…
    </div>
  )

  if (!rows.length) return (
    <div style={{ padding: 24, textAlign: 'center', color: '#7a89b8', fontSize: 12 }}>
      No preview available.
    </div>
  )

  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse',
      fontSize: 11, fontFamily: 'inherit',
    }}>
      <thead>
        <tr>
          {cols.map(col => (
            <th key={col} style={{
              padding: '6px 10px', textAlign: 'left',
              background: '#f7f9fc', borderBottom: '1px solid #e4e9f2',
              color: '#2A3B7C', fontWeight: 600, whiteSpace: 'nowrap',
              position: 'sticky', top: 0,
            }}>
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f7f9fc' }}>
            {cols.map(col => (
              <td key={col} style={{
                padding: '5px 10px', borderBottom: '0.5px solid #e4e9f2',
                color: '#4a5568', whiteSpace: 'nowrap',
              }}>
                {row[col] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const MessageInput = forwardRef(function MessageInput({
  onSend, disabled, onFileSelect, onOpenArtifacts,
  fileData, thresholds, csvPreviewOpen, onToggleCsvPreview,
  onReopenCriteria, onRemoveFile,
}, ref) {
  const [text, setText] = useState('')
  const [activeKB, setActiveKB] = useState(['student_success', 'general'])
  const textareaRef = useRef(null)
  const fileInputRef = useRef(null)

  useImperativeHandle(ref, () => ({
    openFilePicker: () => fileInputRef.current?.click(),
  }))

  function toggleSource(source) {
    setActiveKB(prev =>
      prev.includes(source)
        ? prev.filter(s => s !== source)
        : [...prev, source]
    )
  }

  function getKbScope() {
    const order = ['student_success', 'school', 'general', 'web']
    const selected = order.filter((k) => activeKB.includes(k))
    // CSV token list allows strict backend routing while still supporting combinations.
    return selected.join(',') || 'general'
  }
  const kbScope = getKbScope()

  function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, kbScope)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function handleInput(e) {
    setText(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
  }

  async function handleDriveClick() {
    try {
      const { fileId, fileName, accessToken } = await openGooglePicker()
      const blob = await downloadDriveFile(fileId, accessToken)
      const file = new File([blob], fileName)
      if (onFileSelect) onFileSelect(file)
    } catch (e) {
      if (e.message !== 'cancelled') {
        console.error('Drive error:', e)
      }
    }
  }

  return (
    <div>
      {fileData && (
        <div style={{
          borderTop: '1px solid #e4e9f2',
          background: '#fff',
          padding: '6px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          flexWrap: 'wrap',
        }}>
          <div
            className="file-pill"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              background: '#f7f9fc',
              border: '0.5px solid #e4e9f2',
              borderRadius: 6,
              padding: '3px 8px',
            }}
          >
            <button
              type="button"
              onClick={onToggleCsvPreview}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 0, fontSize: 11, fontWeight: 500, color: '#2A3B7C',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="#3E94A5" strokeWidth="2" width="13" height="13">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              {fileData.filename || 'data.csv'}
              <span style={{ color: '#7a89b8', fontSize: 10 }}>
                {csvPreviewOpen ? '▲' : '▼'}
              </span>
            </button>
            {onRemoveFile && (
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation()
                  if (window.confirm('Remove this file and clear all analysis? This cannot be undone.')) {
                    onRemoveFile()
                  }
                }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#7a89b8', fontSize: 13, lineHeight: 1,
                  padding: '0 2px', marginLeft: 2,
                }}
                title="Remove file"
              >
                ✕
              </button>
            )}
          </div>

          <span style={{ color: '#e4e9f2' }}>·</span>

          <div style={{ display: 'flex', gap: 5, flex: 1, flexWrap: 'wrap' }}>
            {thresholds && Object.entries({
              chronic_absence_threshold: v => `≥${Math.round(v * 100)}% absent`,
              suspension_min: v => `≥${v} suspension${v !== 1 ? 's' : ''}`,
              academic_min_courses: v => `fail ≥${v} course${v !== 1 ? 's' : ''}`,
            }).map(([key, fmt]) =>
              thresholds[key] != null ? (
                <span key={key} style={{
                  background: '#f7f9fc', border: '0.5px solid #e4e9f2',
                  borderRadius: 4, padding: '2px 7px', color: '#7a89b8', fontSize: 11,
                }}>
                  {fmt(thresholds[key])}
                </span>
              ) : null
            )}
          </div>

          {onReopenCriteria && (
            <button
              type="button"
              onClick={onReopenCriteria}
              style={{
                fontSize: 11, color: '#3E94A5', background: 'none',
                border: '0.5px solid #3E94A5', borderRadius: 5,
                padding: '3px 9px', cursor: 'pointer', whiteSpace: 'nowrap',
                fontWeight: 500, marginLeft: 'auto',
              }}
            >
              Change criteria →
            </button>
          )}
        </div>
      )}

      {csvPreviewOpen && fileData && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
          onClick={() => onToggleCsvPreview()}
        >
          <div style={{
            background: '#fff',
            borderRadius: 12,
            width: '80vw',
            maxWidth: 900,
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid #e4e9f2',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#2A3B7C' }}>
                  {fileData.filename || 'student_data.csv'}
                </div>
                <div style={{ fontSize: 11, color: '#7a89b8', marginTop: 2 }}>
                  {fileData.rows?.toLocaleString() || '?'} rows · first 50 shown
                </div>
              </div>
              <button
                type="button"
                onClick={onToggleCsvPreview}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 18, color: '#7a89b8', lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1 }}>
              <CsvPreviewTable fileData={fileData} />
            </div>
          </div>
        </div>
      )}

    <div className="input-wrap">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px 0',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11, color: '#7a89b8' }}>Searching</span>

        <button
          type="button"
          onClick={() => toggleSource('student_success')}
          style={{
            padding: '3px 10px',
            borderRadius: 20,
            border: '1px solid',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: activeKB.includes('student_success') ? '#edf6f8' : '#f4f4f4',
            color: activeKB.includes('student_success') ? '#1b6070' : '#999',
            borderColor: activeKB.includes('student_success') ? '#b8dde6' : '#ddd',
          }}
        >
          ● Student success KB
        </button>

        <button
          type="button"
          onClick={() => toggleSource('school')}
          style={{
            padding: '3px 10px',
            borderRadius: 20,
            border: '1px solid',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: activeKB.includes('school') ? '#eef0f9' : '#f4f4f4',
            color: activeKB.includes('school') ? '#2A3B7C' : '#999',
            borderColor: activeKB.includes('school') ? '#d4d9ee' : '#ddd',
          }}
        >
          🏫 School-based
        </button>

        <button
          type="button"
          onClick={() => toggleSource('general')}
          style={{
            padding: '3px 10px',
            borderRadius: 20,
            border: '1px solid #ddd',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
            opacity: 1,
            background: activeKB.includes('general') ? '#f0f0f0' : 'white',
            color: '#555',
          }}
        >
          ◎ General knowledge
        </button>

        <button
          type="button"
          onClick={() => toggleSource('web')}
          style={{
            padding: '3px 10px',
            borderRadius: 20,
            border: '1px solid',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            fontFamily: 'inherit',
            background: activeKB.includes('web') ? '#fdf3e1' : '#f4f4f4',
            color: activeKB.includes('web') ? '#7a5c10' : '#999',
            borderColor: activeKB.includes('web') ? '#f0d898' : '#ddd',
          }}
        >
          🌐 Web search
        </button>

        <PendingApprovalChip />
        {import.meta.env.DEV && (
          <span
            title="Debug: exact source tokens sent to backend"
            style={{
              marginLeft: 'auto',
              padding: '3px 8px',
              borderRadius: 6,
              border: '1px dashed #c9d2ea',
              fontSize: 10,
              fontWeight: 600,
              color: '#5a6a98',
              background: '#f7f9ff',
              letterSpacing: '0.02em',
            }}
          >
            source tokens: {kbScope}
          </span>
        )}
      </div>
      <div className="input-box">
        <textarea
          ref={textareaRef}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Ask about your students, upload data, or create an artifact…"
          rows={1}
        />
        <div className="input-actions">
          <button
            className="icon-btn"
            title="Upload student data"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
          <button
            className="icon-btn"
            type="button"
            title="Pick a file from Google Drive"
            onClick={handleDriveClick}
            disabled={disabled}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L4 10h4v10h8V10h4L12 2z" />
              <path d="M4 18h16" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Generate artifacts"
            onClick={onOpenArtifacts}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <button
            className="send-btn"
            onClick={handleSubmit}
            disabled={disabled || !text.trim()}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
      <div className="input-hint">EdVise supports educators — always apply your professional judgment.</div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.xls,.pdf,.docx"
        style={{ display: 'none' }}
        onChange={e => { if (e.target.files[0] && onFileSelect) onFileSelect(e.target.files[0]); e.target.value = '' }}
      />
    </div>
    </div>
  )
})

export default MessageInput
