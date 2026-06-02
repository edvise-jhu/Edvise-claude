import { useState, useEffect } from 'react'
import ActionPlanPanel from './ActionPlanPanel'
import MeetingAgenda from './MeetingAgenda'
import Report from './Report'
import { generateArtifact, saveArtifact } from '../../lib/api'

const TABS = [
  { id: 'notes', label: 'Notes' },
  { id: 'action_plan', label: 'Action plan' },
  { id: 'agenda', label: 'Agenda' },
  { id: 'report', label: 'Reports' },
]

function ArtifactLoadingState({ type }) {
  const label = type === 'action_plan' ? 'action plan' : type === 'agenda' ? 'meeting agenda' : 'report'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, minHeight: 200 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: '#3E94A5', animation: 'artifact-bounce 1.2s infinite', animationDelay: `${i * 0.2}s` }} />
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#7a89b8' }}>Generating your {label}...</div>
    </div>
  )
}

function NoteCard({ note, isOpen, onToggle, onDelete, isSelected, onSelect, selectMode }) {
  return (
    <div className={`notes-card${isSelected ? ' selected' : ''}`}>
      <div className="notes-card-header" onClick={selectMode ? onSelect : onToggle}>
        {selectMode && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onSelect}
            onClick={e => e.stopPropagation()}
            style={{ accentColor: '#3E94A5', width: 14, height: 14, flexShrink: 0 }}
          />
        )}
        <span className="notes-card-drag">⠿</span>
        <span className="notes-card-title">{note.title || (note.content || '').slice(0, 60) + '…'}</span>
        <div className="notes-card-actions">
          <button
            type="button"
            className="notes-card-btn"
            onClick={e => { e.stopPropagation(); onDelete() }}
            title="Delete note"
          >
            🗑
          </button>
          <button type="button" className="notes-card-btn" onClick={e => { e.stopPropagation(); onToggle() }}>
            {isOpen ? '∧' : '∨'}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="notes-card-body">
          {note.content}
        </div>
      )}
    </div>
  )
}

export default function ArtifactPanel({
  analysisContext,
  onClose,
  onExpand,
  artifactExpanded,
  activeTab: controlledTab,
  onTabChange,
  reportItems = [],
  setReportItems,
  noteItems = [],
  setNoteItems,
  conversationSnapshot = [],
  accessToken = null,
  artifactSeed = null,
  onArtifactSeedConsumed,
  onSaved,
  onArtifactGenerated,
}) {
  const [internalTab, setInternalTab] = useState('notes')
  const activeTab = controlledTab ?? internalTab
  function setActiveTab(tab) {
    setInternalTab(tab)
    onTabChange?.(tab)
  }

  const [artifacts, setArtifacts] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reportGenerating, setReportGenerating] = useState(false)
  const [reportError, setReportError] = useState(null)

  const [openNotes, setOpenNotes] = useState({})
  const [selectMode, setSelectMode] = useState(false)
  const [selectedNotes, setSelectedNotes] = useState(new Set())
  const [reportTemplate, setReportTemplate] = useState('full_analysis')
  const [notesDirty, setNotesDirty] = useState(false)

  const artifact = artifacts[activeTab]

  useEffect(() => {
    if (artifactSeed == null) setLoading(false)
  }, [artifactSeed])

  useEffect(() => {
    if (!artifactSeed?.type) return
    if (artifactSeed.data === null) return
    if (artifactSeed.data?.error) return
    setArtifacts(prev => ({ ...prev, [artifactSeed.type]: artifactSeed.data }))
    onArtifactSeedConsumed?.()
  }, [artifactSeed])

  function toggleNote(id) {
    setOpenNotes(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function deleteNote(id) {
    setNoteItems?.(prev => prev.filter(n => n.id !== id))
    setNotesDirty(true)
  }

  function toggleSelectNote(id) {
    setSelectedNotes(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectAllNotes() {
    setSelectedNotes(new Set(noteItems.map(n => n.id)))
  }

  function clearNoteSelection() {
    setSelectedNotes(new Set())
  }

  async function handleSaveNotes() {
    setNotesDirty(false)
  }

  function handleDiscardNotes() {
    setNotesDirty(false)
  }

  async function handleGenerateReportFromNotes() {
    const notesToInclude = selectMode && selectedNotes.size > 0
      ? noteItems.filter(n => selectedNotes.has(n.id))
      : noteItems
    setSelectMode(false)
    setReportGenerating(true)
    setReportError(null)
    try {
      const context = {
        ...(analysisContext || {}),
        report_items: reportItems || [],
        note_items: notesToInclude.map(n => n.content),
        report_template: reportTemplate,
        conversation_snapshot: conversationSnapshot || [],
      }
      const result = await generateArtifact('report', context, null, accessToken)
      if (!result || result.error) throw new Error(result?.error || 'Generation failed')
      setArtifacts(prev => ({ ...prev, report: result }))
      onArtifactGenerated?.('report', result)
      setActiveTab('report')
    } catch (e) {
      setReportError(e.message || String(e))
    } finally {
      setReportGenerating(false)
    }
  }

  async function handleSaveActionPlan(plan) {
    const result = await saveArtifact('action_plan', plan, null, accessToken)
    onSaved?.('action_plan')
    return result
  }

  async function handleSaveAgenda(agendaData) {
    const result = await saveArtifact('agenda', agendaData, null, accessToken)
    onSaved?.('agenda')
    return result
  }

  async function handleSaveReport(reportData) {
    const result = await saveArtifact('report', reportData, null, accessToken)
    onSaved?.('report')
    return result
  }

  async function handleGenerate() {
    if (!analysisContext) { setError('Upload and analyze student data first.'); return }
    setLoading(true); setError(null)
    try {
      const result = await generateArtifact(activeTab, analysisContext, null, accessToken)
      if (result.error) throw new Error(result.error)
      setArtifacts(prev => ({ ...prev, [activeTab]: result }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleGenerateReport() {
    setReportGenerating(true); setReportError(null)
    try {
      const context = {
        ...(analysisContext || {}),
        report_items: reportItems || [],
        conversation_snapshot: conversationSnapshot || [],
      }
      const result = await generateArtifact('report', context, null, accessToken)
      if (!result || result.error) throw new Error(result?.error || 'Generation failed')
      setArtifacts(prev => ({ ...prev, report: result }))
      onArtifactGenerated?.('report', result)
    } catch (e) {
      setReportError(e.message || String(e))
    } finally {
      setReportGenerating(false)
    }
  }

  function renderContent() {
    if (!artifact) return null
    if (activeTab === 'action_plan') return <ActionPlanPanel data={artifact} onSave={handleSaveActionPlan} onDiscard={onClose} />
    if (activeTab === 'agenda') return <MeetingAgenda data={artifact} onSave={handleSaveAgenda} onDiscard={onClose} />
    if (activeTab === 'report') return <Report data={artifact} onSave={handleSaveReport} onDiscard={onClose} />
    return null
  }

  const seedLoading = artifactSeed?.type === activeTab && artifactSeed?.data === null
  const showStandardEmpty = activeTab !== 'report' && activeTab !== 'notes' && !analysisContext && !artifact && !seedLoading
  const showStandardReady = activeTab !== 'report' && activeTab !== 'notes' && analysisContext && !artifact && !loading && !seedLoading

  return (
    <>
      {/* Tabs + expand/close */}
      <div className="artifact-tabs" style={{ position: 'relative' }}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`a-tab${activeTab === t.id ? ' active' : ''}`}
            onClick={() => { setActiveTab(t.id); setError(null); setReportError(null) }}
          >
            {t.label}
            {t.id === 'notes' && noteItems.length > 0 && (
              <span style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, background: '#3E94A5', color: 'white', borderRadius: 10, padding: '1px 5px' }}>
                {noteItems.length}
              </span>
            )}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, paddingRight: 8 }}>
          <button
            type="button"
            className="tool-btn"
            onClick={onExpand}
            title={artifactExpanded ? 'Collapse panel' : 'Expand panel'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {artifactExpanded
                ? <><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" /></>
                : <><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></>
              }
            </svg>
          </button>
          <button type="button" className="tool-btn" onClick={onClose} title="Close panel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Toolbar — only for non-notes tabs */}
      {activeTab !== 'notes' && (
        <div className="artifact-toolbar">
          <button className="tool-btn" title="Download" onClick={() => window.print()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>Auto-filled · edit freely</span>
        </div>
      )}

      {/* Body */}
      <div className="artifact-body">
        {seedLoading ? (
          <ArtifactLoadingState type={activeTab} />
        ) : (
          <>
            {/* ── NOTES TAB ── */}
            {activeTab === 'notes' && (
              <div>
                {conversationSnapshot?.length > 0 && (
                  <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', marginBottom: 12, lineHeight: 1.4 }}>
                    {conversationSnapshot[0]?.content?.slice(0, 80) || 'Current conversation'}
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                  <button type="button" onClick={() => { setActiveTab('action_plan'); handleGenerate() }}
                    style={{ padding: '8px 10px', border: '1px solid #10B98133', background: '#f0fdf4', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#15803d', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}>
                    📋 Create Action Plan
                  </button>
                  <button type="button" onClick={() => { setActiveTab('agenda'); handleGenerate() }}
                    style={{ padding: '8px 10px', border: '1px solid #3E94A533', background: '#f0f8fb', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#1b6070', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}>
                    📅 Create Agenda
                  </button>
                </div>
                <button type="button"
                  onClick={() => setSelectMode(s => !s)}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #6c3fc533', background: '#faf5ff', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#6c3fc5', display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', marginBottom: 14 }}>
                  ✨ Create Report
                </button>

                {selectMode && (
                  <div className="notes-select-modal">
                    <div className="notes-select-header">
                      <span className="notes-select-title">Select notes for Report</span>
                      <button type="button" onClick={() => setSelectMode(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)' }}>×</button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div className="notes-select-actions">
                        <span onClick={selectAllNotes}>Select all</span>
                        <span>·</span>
                        <span onClick={clearNoteSelection}>Clear</span>
                      </div>
                      <span className="notes-select-count">{selectedNotes.size} of {noteItems.length} selected</span>
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 8 }}>
                      REPORT TEMPLATE
                    </div>
                    <div className="notes-template-grid">
                      <button type="button" className={`notes-template-btn${reportTemplate === 'full_analysis' ? ' active' : ''}`} onClick={() => setReportTemplate('full_analysis')}>
                        ▤ Full Analysis
                      </button>
                      <button type="button" className={`notes-template-btn${reportTemplate === 'family_letter' ? ' active' : ''}`} onClick={() => setReportTemplate('family_letter')}>
                        👤 Family Letter
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button type="button" onClick={() => setSelectMode(false)}
                        style={{ flex: 1, padding: '8px', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Cancel
                      </button>
                      <button type="button" className="notes-generate-btn" style={{ flex: 2 }}
                        onClick={handleGenerateReportFromNotes}
                        disabled={reportGenerating}>
                        {reportGenerating ? 'Generating…' : 'Generate Report'}
                      </button>
                    </div>
                  </div>
                )}

                {noteItems.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                    {noteItems.length} note{noteItems.length > 1 ? 's' : ''} — click a card to expand
                  </div>
                )}

                {noteItems.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)', fontSize: 12 }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
                    <div>No notes yet. Click &quot;Add to Notes&quot; on any message to save it here.</div>
                  </div>
                ) : (
                  noteItems.map(note => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      isOpen={!!openNotes[note.id]}
                      onToggle={() => toggleNote(note.id)}
                      onDelete={() => deleteNote(note.id)}
                      isSelected={selectedNotes.has(note.id)}
                      onSelect={() => toggleSelectNote(note.id)}
                      selectMode={selectMode}
                    />
                  ))
                )}

                {noteItems.length > 0 && (
                  <div className="notes-footer-btns">
                    <button type="button" className="notes-discard-btn" onClick={handleDiscardNotes}>Discard</button>
                    <button type="button" className="notes-save-btn" onClick={handleSaveNotes}>Save Notes</button>
                  </div>
                )}
              </div>
            )}

            {/* ── OTHER TABS ── */}
            {error && activeTab !== 'notes' && (
              <div style={{ background: '#fff0f0', border: '1px solid #ffc0c0', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#a32d2d', marginBottom: 12 }}>
                {error}
              </div>
            )}

            {activeTab === 'report' && (
              <>
                {reportError && (
                  <div style={{ padding: '10px 14px', background: '#fff3f3', border: '1px solid #f7c1c1', borderRadius: 8, fontSize: 12, color: '#a32d2d', margin: '12px 0' }}>
                    {reportError}
                  </div>
                )}
                {reportItems.length === 0 && !artifacts.report ? (
                  <div className="artifact-empty">
                    <p>Add charts and analysis cards to build your report.</p>
                  </div>
                ) : (
                  <div>
                    {reportItems.length > 0 && (
                      <div>
                        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{reportItems.length} item(s) added</span>
                          <button type="button" className="save-btn" onClick={handleGenerateReport} disabled={reportGenerating}>
                            {reportGenerating ? 'Generating…' : 'Generate report'}
                          </button>
                        </div>
                        {reportItems.map((item, i) => (
                          <div key={i} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                            <div style={{ padding: '7px 12px', background: 'var(--bg)', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                              <span>{item.type.replace(/_/g, ' ').toUpperCase()}</span>
                              <button type="button" onClick={() => setReportItems?.(prev => prev.filter((_, j) => j !== i))}
                                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14 }}>×</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {artifacts.report && (
                      <div style={{ marginTop: 16 }}>
                        <Report data={artifacts.report} onSave={handleSaveReport} onDiscard={onClose} />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {showStandardEmpty && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
                <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>No artifact yet</div>
                <div>Ask EdVise to create an action plan, meeting agenda, or notes and it will appear here.</div>
              </div>
            )}

            {showStandardReady && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
                <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Ready to generate</div>
                <p style={{ marginBottom: 12 }}>Create a {TABS.find(t => t.id === activeTab)?.label} from your analysis.</p>
                <button type="button" className="save-btn" onClick={handleGenerate} disabled={loading || !analysisContext}>
                  {loading ? 'Generating…' : 'Generate'}
                </button>
              </div>
            )}

            {loading && activeTab !== 'report' && activeTab !== 'notes' && !artifact && !seedLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 0.8s linear infinite' }}>
                  <circle cx="12" cy="12" r="10" strokeDasharray="30" strokeDashoffset="10" />
                </svg>
                Generating with Claude…
              </div>
            )}

            {activeTab !== 'report' && activeTab !== 'notes' && renderContent()}
          </>
        )}
      </div>
    </>
  )
}
