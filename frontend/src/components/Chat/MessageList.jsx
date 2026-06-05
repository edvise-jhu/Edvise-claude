import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { stripSuggestionsFromText, normalizeSuggestionText } from '../../lib/suggestionsUtils'
import remarkGfm from 'remark-gfm'
import { openKbPdfInNewTab } from '../../lib/api'
import TypingIndicator from './TypingIndicator'
import DataConfirmCard from '../Cards/DataConfirmCard'
import SubgroupPickerCard from '../Cards/SubgroupPickerCard'
import IntentPickerCard from '../Cards/IntentPickerCard'
import ClarifyWizardCard from '../Cards/ClarifyWizardCard'
import VariableSummaryCard from '../Cards/VariableSummaryCard'
import RiskOverviewCard from '../Cards/RiskOverviewCard'
import GradeComparisonCard from '../Cards/GradeComparisonCard'
import SELFallbackCard from '../Cards/SELFallbackCard'
import CriteriaSettingCard from '../Cards/CriteriaSettingCard'
import StudentTableCard from '../Cards/StudentTableCard'
import ArtifactRenderer from '../ArtifactRenderer'
import VizRouter from '../VizRouter'
import StudentProfileCard from '../viz/StudentProfileCard'

const STARTERS = [
  { title: 'Foundational Analysis', desc: 'Attendance, behavior & academic risk' },
  { title: 'Ask about my data', desc: 'Explore patterns or student groups' },
  { title: 'Brainstorm interventions', desc: 'Evidence-based strategies from KB' },
  { title: 'Meeting agenda', desc: 'Auto-fill from today\'s analysis' },
]

function parseArtifacts(text) {
  if (!text || !text.includes('<artifact')) return [{ type: 'text', content: text }]

  const parts = []
  const regex = /<artifact[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/artifact>/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    console.log('artifact type found:', match[1])
    if (match[1] === 'sel_chart') {
      console.log('sel_chart raw JSON:', match[2].trim().slice(0, 500))
      try {
        const parsed = JSON.parse(match[2].trim())
        console.log('sel_chart parsed groups:', parsed.groups?.length, parsed.groups?.[0])
      } catch (e) {
        console.log('sel_chart JSON parse error:', e.message)
      }
    }

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim()
      if (before) parts.push({ type: 'text', content: before })
    }

    const jsonStr = match[2].trim()
    try {
      const artifact = JSON.parse(jsonStr)
      artifact.artifactType = match[1]
      parts.push({ type: 'artifact', content: artifact })
    } catch (e) {
      console.warn('Artifact parse failed:', e.message)
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    const after = text.slice(lastIndex).trim()
    if (after && !after.includes('<artifact')) {
      parts.push({ type: 'text', content: after })
    }
  }

  if (import.meta.env.DEV) {
    const nArt = parts.filter((p) => p.type === 'artifact').length
    console.debug('[parseArtifacts] parts=%s artifacts=%s', parts.length, nArt)
  }

  return parts.length > 0 ? parts : [{ type: 'text', content: text }]
}

function isMarkdownTableDivider(line) {
  const s = String(line || '').trim()
  if (!s.includes('|')) return false
  const normalized = s.replace(/\|/g, '').replace(/:/g, '').replace(/-/g, '').trim()
  return normalized === '' && s.includes('---')
}

function parseMarkdownTableLines(lines) {
  const clean = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, ''))
  if (clean.length < 2) return null

  const headers = clean[0].split('|').map((c) => c.trim())
  const rows = clean
    .slice(2)
    .map((row) => row.split('|').map((c) => c.trim()))
    .filter((row) => row.length > 0)

  if (!headers.length || !rows.length) return null
  return {
    artifactType: 'table',
    type: 'table',
    title: 'Table',
    headers,
    rows,
  }
}

function splitTextAndMarkdownTables(text) {
  if (!text) return []
  const lines = text.split('\n')
  const out = []
  let i = 0
  let textBuffer = []

  const flushText = () => {
    if (!textBuffer.length) return
    const content = textBuffer.join('\n').trim()
    if (content) out.push({ type: 'text', content })
    textBuffer = []
  }

  while (i < lines.length) {
    const cur = lines[i]
    const next = i + 1 < lines.length ? lines[i + 1] : ''
    const looksLikeHeader = cur.includes('|')
    const looksLikeDivider = isMarkdownTableDivider(next)

    if (looksLikeHeader && looksLikeDivider) {
      flushText()
      const tableLines = [cur, next]
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        tableLines.push(lines[i])
        i += 1
      }
      const tableArtifact = parseMarkdownTableLines(tableLines)
      if (tableArtifact) out.push({ type: 'artifact', content: tableArtifact })
      else out.push({ type: 'text', content: tableLines.join('\n') })
      continue
    }

    textBuffer.push(cur)
    i += 1
  }

  flushText()
  return out
}

function normalizeAssistantParts(text) {
  const parts = parseArtifacts(text)
  const normalized = []
  for (const part of parts) {
    if (part.type === 'artifact') {
      normalized.push(part)
      continue
    }
    const split = splitTextAndMarkdownTables(part.content || '')
    if (split.length) normalized.push(...split)
  }
  return normalized
}

function renderAssistantContent(text, onAddToReport) {
  if (!text) return null
  const { text: visible } = stripSuggestionsFromText(text)
  const parts = normalizeAssistantParts(visible)

  return parts.map((part, i) => {
    if (part.type === 'text') {
      if (!part.content.trim()) return null
      return <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
    }
    if (part.type === 'artifact') {
      const a = part.content
      const title =
        a.title ||
        (a.artifactType === 'sel_chart' ? 'SEL Factor Analysis' : a.artifactType === 'table' ? 'Table' : 'Visualization')
      return (
        <div
          key={i}
          style={{
            margin: '12px 0',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 14px',
              background: 'var(--bg)',
              borderBottom: '1px solid var(--border)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{title}</span>
            <button
              type="button"
              className="add-to-report-btn"
              onClick={() => {
                const { type: innerType, ...rest } = a
                onAddToReport?.({ ...rest, type: 'dynamic_artifact', innerType })
              }}
            >
              + Add to report
            </button>
          </div>
          <div style={{ padding: 16 }}>
            <ArtifactRenderer artifact={a} />
          </div>
        </div>
      )
    }
    return null
  })
}

function ActionPlanScaffoldCard({ msg }) {
  const [extra, setExtra] = useState('')
  return (
    <div
      style={{
        border: '1px solid #e4e9f2',
        borderRadius: 12,
        overflow: 'hidden',
        maxWidth: 460,
        background: 'white',
      }}
    >
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid #e4e9f2',
          fontSize: 13,
          fontWeight: 600,
          color: '#2A3B7C',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{msg.question}</span>
        <span style={{ fontSize: 11, color: '#7a89b8', fontWeight: 400 }}>Select one</span>
      </div>
      <div style={{ padding: '6px 8px' }}>
        {(msg.options || []).map((opt, i) => (
          <button
            key={i}
            type="button"
            onClick={() => msg.onSelect?.(opt)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '10px 12px',
              border: '1px solid transparent',
              borderRadius: 8,
              background: 'transparent',
              fontSize: 13,
              color: '#2A3B7C',
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
              marginBottom: 2,
              transition: 'all 0.1s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#f0f7f9'
              e.currentTarget.style.borderColor = '#3E94A5'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.borderColor = 'transparent'
            }}
          >
            {opt}
          </button>
        ))}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #e4e9f2',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Or describe your focus group..."
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && extra.trim()) {
              msg.onSelect?.(extra.trim())
              setExtra('')
            }
          }}
          style={{
            flex: 1,
            padding: '7px 10px',
            border: '1px solid #e4e9f2',
            borderRadius: 7,
            fontSize: 12,
            fontFamily: 'Inter, sans-serif',
            outline: 'none',
            color: '#2A3B7C',
          }}
        />
        <span style={{ fontSize: 11, color: '#7a89b8' }}>↵</span>
      </div>
    </div>
  )
}

function InlineCard({ msg, onActionClick, onAddToReport, onViewHighestRiskStudents }) {
  const add = msg.onAddToReport ?? onAddToReport
  switch (msg.type) {
    case 'action_plan_scaffold':
      return <ActionPlanScaffoldCard msg={msg} />
    case 'data_confirm':
      return <DataConfirmCard data={msg.data} onConfirm={msg.onConfirm} />
    case 'criteria_confirm':
      return <CriteriaSettingCard data={msg.data} onConfirm={msg.onConfirm} />
    case 'subgroup_picker':
      return <SubgroupPickerCard data={msg.data} onConfirm={msg.onConfirm} />
    case 'variable_summary':
      return <VariableSummaryCard data={msg.data} onConfirmed={msg.onConfirmed} />
    case 'risk_overview':
      return (
        <RiskOverviewCard
          data={msg.data}
          onActionClick={onActionClick}
          onAddToReport={add}
          onViewHighestRiskStudents={msg.onViewHighestRiskStudents ?? onViewHighestRiskStudents}
        />
      )
    case 'student_table':
      return <StudentTableCard data={{ ...msg.data, onAction: onActionClick }} />
    case 'student_profile':
      return <StudentProfileCard data={msg.data} />
    case 'grade_comparison':
      if (Array.isArray(msg.data?.grades) && msg.data.grades.length > 0) {
        return (
          <VizRouter
            data={{ type: 'grade_comparison', ...msg.data }}
            onAction={onActionClick}
          />
        )
      }
      return <GradeComparisonCard data={msg.data} onAddToReport={add} onAction={onActionClick} />
    case 'sel':
    case 'sel_fallback':
      return <SELFallbackCard data={msg.data} onAction={onActionClick} />
    case 'intent_picker':
      return <IntentPickerCard data={msg.data} onSelect={msg.onSelect} />
    case 'clarify_wizard':
      return (
        <ClarifyWizardCard
          data={msg.data}
          onComplete={msg.onComplete}
          onSkip={msg.onSkip}
        />
      )
    default:
      return null
  }
}

const numStyle = { fontWeight: 600, opacity: 0.9, marginRight: 6 }

function isActiveStreamSlot(msg) {
  if (!msg) return false
  if (msg.isLoading) return true
  if (msg.id === '__loading_students__') return true
  // stream-* id stays on completed replies; only treat as in-flight while content is still empty
  if (typeof msg.id === 'string' && msg.id.startsWith('stream-')) {
    return !String(msg.content || '').trim()
  }
  return false
}

function AssistantMessage({ msg, isLast, threadBusy, onSuggestionClick, onAddToReport, onAddToNotes, accessToken = null }) {
  const streamSlot = isActiveStreamSlot(msg)
  // Only show typing on the in-flight stream slot — never blank out older completed replies
  const showCursor = isLast && streamSlot && threadBusy && !String(msg.content || '').trim()
  const isFileLoading = Boolean(msg?.isLoading && msg?.loadingLabel)

  return (
    <div className="msg-wrap assistant">
      <div className="assistant-row">
        <div className="ev-av">Ev</div>
        <div className="assistant-body">
          {isFileLoading ? (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                color: 'var(--text-muted)',
                fontSize: 13,
                lineHeight: 1.4,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  border: '2px solid #b8dde6',
                  borderTopColor: '#3E94A5',
                  borderRadius: '50%',
                  display: 'inline-block',
                  animation: 'spin 1s linear infinite',
                  flexShrink: 0,
                }}
              />
              <span>{msg.loadingLabel}</span>
            </div>
          ) : (
              <>
                {msg.viz && <VizRouter data={msg.viz} onAction={onSuggestionClick} />}
                {String(msg.content || '').trim()
                  ? renderAssistantContent(msg.content, onAddToReport)
                  : null}
                {showCursor ? <TypingIndicator /> : null}
              </>
            )}
          {msg.actionPills?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0 4px' }}>
              {msg.actionPills.map((pill, i) => (
                <button
                  key={i}
                  type="button"
                  className="sug-btn"
                  style={{
                    border: '1px solid #3E94A5',
                    color: i === 0 ? '#fff' : '#3E94A5',
                    background: i === 0 ? '#3E94A5' : 'transparent',
                    borderRadius: 999,
                    padding: '6px 14px',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                  onClick={() => onSuggestionClick(pill)}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          )}
          {msg.sources && msg.sources.length > 0 && (
            <div className="sources" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              {[
                { key: 'src-student-success', label: 'Student Success KB' },
                { key: 'src-school', label: 'School-based' },
                { key: 'src-general', label: 'General knowledge' },
                { key: 'src-web', label: 'Web search' },
              ].map((group) => {
                const items = msg.sources.filter((s) => (typeof s === 'string' ? '' : s?.cls) === group.key)
                if (!items.length) return null
                return (
                  <div key={group.key}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>{group.label}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {items.map((src, i) => {
                const item = typeof src === 'string' ? { label: src } : src
                const num = item.num != null ? item.num : null
                const label = item.label || item.url || src
                const pillStyle = (cls) => ({
                  padding: '3px 10px',
                  borderRadius: 20,
                  fontSize: 11,
                  fontWeight: 500,
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background:
                    cls === 'src-web' ? '#fdf3e1' :
                    cls === 'src-school' ? '#e8efff' :
                    cls === 'src-general' ? '#f3f4f6' : '#edf6f8',
                  color:
                    cls === 'src-web' ? '#7a5c10' :
                    cls === 'src-school' ? '#26408b' :
                    cls === 'src-general' ? '#5b6473' : '#1b6070',
                  border:
                    cls === 'src-web' ? '1px solid #f0d898' :
                    cls === 'src-school' ? '1px solid #c5d5ff' :
                    cls === 'src-general' ? '1px solid #d9dde5' : '1px solid #b8dde6',
                  cursor: item.url ? 'pointer' : 'default',
                })
                const prefix = num != null ? <span style={numStyle}>[{num}]</span> : null
                if (item.url) {
                  return (
                    <a
                      key={i}
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`src-pill ${item.cls || 'src-web'}`}
                      style={{ ...pillStyle('src-web'), textDecoration: 'none' }}
                      title={item.url}
                    >
                      {prefix}
                      🌐 {label}
                    </a>
                  )
                }
                if (item.document_id && item.cls === 'src-kb') {
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`src-pill ${item.cls || 'src-kb'}`}
                      style={pillStyle('src-kb')}
                      title="Open PDF"
                      onClick={() => openKbPdfInNewTab(item.document_id, accessToken)}
                    >
                      {prefix}
                      📄 {label}
                    </button>
                  )
                }
                return (
                  <span key={i} className={`src-pill ${item.cls || 'src-student-success'}`} style={pillStyle(item.cls || 'src-student-success')}>
                    {prefix}
                    {label}
                </span>
                )
              })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {msg.suggestions && msg.suggestions.length > 0 && (msg.isAnalysisMessage || msg.viz) && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, marginTop: 14 }}>
                {msg.suggestions.length > 1 ? 'Or explore:' : null}
              </div>
            <div className="suggestions">
                {msg.suggestions.map((s, i) => {
                  const label = normalizeSuggestionText(s)
                  if (!label) return null
                  return (
                  <button
                    key={`${i}-${label.slice(0, 24)}`}
                    type="button"
                    className="sug-btn"
                    onClick={() => onSuggestionClick(label)}
                  >
                    {label}
                  </button>
                  )
                })}
              </div>
            </div>
          )}
          {onAddToNotes && msg.role === 'assistant' && msg.content && !msg.isLoading && (
            <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>ADD TO:</span>
              <button
                type="button"
                onClick={() => onAddToNotes({
                  content: msg.content,
                  title: (msg.content || '').slice(0, 60) + ((msg.content || '').length > 60 ? '…' : ''),
                })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 10px',
                  borderRadius: 20,
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-muted)',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'all 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#3E94A5'; e.currentTarget.style.color = '#3E94A5' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}
              >
                📋 Notes
                </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function MessageList({ messages, isStreaming, onStarterClick, onSuggestionClick, onAddToReport, onAddToNotes, onViewHighestRiskStudents, accessToken = null }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isStreaming])

  if (messages.length === 0) {
    return (
      <div className="welcome">
        <div className="welcome-logo">Ev</div>
        <h1>How can I help today?</h1>
        <p>Ask about your student data, explore interventions from the knowledge base, or create an action plan for your team.</p>
        <div className="starters">
          {STARTERS.map((s, i) => (
            <button key={i} className="starter" onClick={() => onStarterClick(s.title)}>
              <div className="starter-title">{s.title}</div>
              <div className="starter-desc">{s.desc}</div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="thread">
      {messages.map((msg, i) => {
        if (msg.role === 'card') {
          return (
            <div key={i} className="msg-wrap assistant">
              <div className="assistant-row">
                <div className="ev-av">Ev</div>
                <div className="assistant-body">
                  <InlineCard msg={msg} onActionClick={onSuggestionClick} onAddToReport={onAddToReport} onViewHighestRiskStudents={onViewHighestRiskStudents} />
                </div>
              </div>
            </div>
          )
        }

        if (msg.role === 'user') {
          return (
            <div key={msg.id || `user-${i}`} className="msg-wrap user">
              <div className="user-bubble">{msg.content || ''}</div>
            </div>
          )
        }

        if (msg.role === 'assistant') {
          return (
            <AssistantMessage
              key={msg.id || `${msg.role}-${i}`}
              msg={msg}
              isLast={i === messages.length - 1}
              threadBusy={isStreaming}
              onSuggestionClick={onSuggestionClick}
              onAddToReport={onAddToReport}
              onAddToNotes={onAddToNotes}
              accessToken={accessToken}
            />
          )
        }

        return null
      })}
      <div ref={bottomRef} />
    </div>
  )
}
