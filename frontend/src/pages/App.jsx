import { useState, useEffect, useCallback } from 'react'
import Sidebar from '../components/Sidebar/Sidebar'
import Chat from '../components/Chat/Chat'
import LibraryView from '../components/LibraryView'
import ArtifactPanel from '../components/ArtifactPanel/ArtifactPanel'
import SavedItemsView from '../components/SavedItemsView'
import Settings from './Settings'
import AdminKB from './AdminKB'
import { listArtifacts } from '../lib/api'

export default function MainApp({ session }) {
  const [mainView, setMainView] = useState('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [artifactOpen, setArtifactOpen] = useState(false)
  const [artifactExpanded, setArtifactExpanded] = useState(false)
  const [artifactTab, setArtifactTab] = useState('notes')
  const [analysisContext, setAnalysisContext] = useState(null)
  const [reportItems, setReportItems] = useState([])
  const [noteItems, setNoteItems] = useState([])
  const [conversationSnapshot, setConversationSnapshot] = useState([])

  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const [chatSessionKey, setChatSessionKey] = useState(0)
  const [openConversationId, setOpenConversationId] = useState(null)
  const [highlightConversationId, setHighlightConversationId] = useState(null)
  const [artifactSeed, setArtifactSeed] = useState(null)
  const [savedCounts, setSavedCounts] = useState({
    action_plan: 0,
    agenda: 0,
    report: 0,
  })
  const [savedRefreshKey, setSavedRefreshKey] = useState(0)
  const [artifactPanelKey, setArtifactPanelKey] = useState(0)

  const isAdmin = session?.user?.email === 'edvisejhu@gmail.com'

  const refreshSavedCounts = useCallback(async () => {
    if (!session?.access_token) return
    try {
      const [ap, ag, rep] = await Promise.all([
        listArtifacts('action_plan', session.access_token),
        listArtifacts('agenda', session.access_token),
        listArtifacts('report', session.access_token),
      ])
      setSavedCounts({
        action_plan: Array.isArray(ap) ? ap.length : 0,
        agenda: Array.isArray(ag) ? ag.length : 0,
        report: Array.isArray(rep) ? rep.length : 0,
      })
    } catch {
      /* ignore */
    }
  }, [session?.access_token])

  useEffect(() => {
    refreshSavedCounts()
  }, [refreshSavedCounts])

  useEffect(() => {
    if (!isAdmin && mainView === 'kb') {
      setMainView('chat')
    }
  }, [isAdmin, mainView])

  function handleAddToReport(item) {
    setReportItems((prev) => [...prev, { ...item, addedAt: new Date() }])
    handleOpenArtifacts('report')
  }

  function handleAddToNotes(item) {
    setNoteItems((prev) => [...prev, { ...item, id: `note_${Date.now()}`, addedAt: new Date() }])
    handleOpenArtifacts('notes')
  }

  function handleToggleExpand() {
    setArtifactExpanded((e) => !e)
  }

  function handleOpenArtifacts(tab) {
    if (tab) {
      setArtifactTab(tab)
      setArtifactOpen(true)
    } else {
      setArtifactOpen((a) => !a)
    }
  }

  function handleConversationSaved() {
    setSidebarRefreshKey((k) => k + 1)
  }

  function handleArtifactGenerated(type, data) {
    if (data === false) {
      setArtifactSeed(null)
      return
    }
    setArtifactSeed({ type, data })
    setArtifactTab(type)
    setArtifactOpen(true)
  }

  function handleArtifactSaved(type) {
    setSavedRefreshKey((k) => k + 1)
    refreshSavedCounts()
    const viewMap = {
      action_plan: 'actions-plans',
      agenda: 'actions-agendas',
      report: 'actions-reports',
    }
    window.setTimeout(() => {
      setMainView(viewMap[type] || 'actions-plans')
      setArtifactOpen(false)
    }, 2000)
  }

  function handleNewChat() {
    try {
      sessionStorage.removeItem('edvise_active_conversation_id')
      sessionStorage.removeItem('edvise_file_session')
      sessionStorage.removeItem('edvise_column_metadata')
      sessionStorage.removeItem('edvise_sel_confirmed')
      console.log('[handleNewChat] file_session cleared:', sessionStorage.getItem('edvise_file_session'))
    } catch {
      /* ignore */
    }
    setArtifactSeed(null)
    setReportItems([])
    setNoteItems([])
    setArtifactExpanded(false)
    setConversationSnapshot([])
    setArtifactPanelKey((k) => k + 1)
    setMainView('chat')
    setOpenConversationId(null)
    setHighlightConversationId(null)
    setAnalysisContext(null)
    setChatSessionKey((k) => k + 1)
  }

  function handleSelectConversation(id) {
    setArtifactSeed(null)
    setReportItems([])
    setNoteItems([])
    setArtifactExpanded(false)
    setConversationSnapshot([])
    setArtifactPanelKey((k) => k + 1)
    setMainView('chat')
    setOpenConversationId(id)
    setHighlightConversationId(id)
    setAnalysisContext(null)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <Sidebar
          session={session}
          onOpenArtifacts={handleOpenArtifacts}
          mainView={mainView}
          setMainView={setMainView}
          refreshKey={sidebarRefreshKey}
          highlightConversationId={highlightConversationId}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
          savedCounts={savedCounts}
        />
      </aside>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {mainView === 'chat' && (
          <Chat
            key={chatSessionKey}
            accessToken={session?.access_token}
            analysisContext={analysisContext}
            onAnalysisReady={setAnalysisContext}
            onToggleSidebar={() => setSidebarCollapsed((s) => !s)}
            onOpenArtifacts={handleOpenArtifacts}
            artifactOpen={artifactOpen}
            onAddToReport={handleAddToReport}
            onAddToNotes={handleAddToNotes}
            chatSessionKey={chatSessionKey}
            openConversationId={openConversationId}
            onConversationHighlight={setHighlightConversationId}
            onConversationSaved={handleConversationSaved}
            onArtifactGenerated={handleArtifactGenerated}
            onConversationSnapshotChange={setConversationSnapshot}
          />
        )}
        {mainView === 'library-all' && (
          <LibraryView filter="all" session={session} accessToken={session?.access_token} />
        )}
        {mainView === 'library-strategy' && (
          <LibraryView filter="strategy" session={session} accessToken={session?.access_token} />
        )}
        {mainView === 'library-reports' && (
          <LibraryView filter="reports" session={session} accessToken={session?.access_token} />
        )}
        {mainView === 'library-pending' && (
          <LibraryView filter="pending" session={session} accessToken={session?.access_token} />
        )}
        {mainView === 'kb' && isAdmin && <AdminKB accessToken={session?.access_token} />}
        {mainView === 'settings' && <Settings />}
        {mainView === 'actions-plans' && (
          <SavedItemsView
            type="action_plan"
            title="Action plans"
            accessToken={session?.access_token}
            refreshKey={savedRefreshKey}
          />
        )}
        {mainView === 'actions-agendas' && (
          <SavedItemsView
            type="agenda"
            title="Meeting agendas"
            accessToken={session?.access_token}
            refreshKey={savedRefreshKey}
          />
        )}
        {mainView === 'actions-reports' && (
          <SavedItemsView
            type="report"
            title="Reports"
            accessToken={session?.access_token}
            refreshKey={savedRefreshKey}
          />
        )}
      </div>

      <aside className={`artifact${artifactOpen ? ' visible' : ''}${artifactExpanded ? ' expanded' : ''}`}>
        <ArtifactPanel
          key={artifactPanelKey}
          analysisContext={analysisContext}
          onClose={() => setArtifactOpen(false)}
          onExpand={handleToggleExpand}
          artifactExpanded={artifactExpanded}
          activeTab={artifactTab}
          onTabChange={setArtifactTab}
          reportItems={reportItems}
          setReportItems={setReportItems}
          noteItems={noteItems}
          setNoteItems={setNoteItems}
          conversationSnapshot={conversationSnapshot}
          accessToken={session?.access_token}
          artifactSeed={artifactSeed}
          onArtifactSeedConsumed={() => setArtifactSeed(null)}
          onSaved={handleArtifactSaved}
          onArtifactGenerated={handleArtifactGenerated}
        />
      </aside>
    </div>
  )
}
