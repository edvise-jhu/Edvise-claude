import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { listConversations } from '../../lib/api'

export default function Sidebar({
  session,
  onOpenArtifacts,
  mainView,
  setMainView,
  refreshKey = 0,
  highlightConversationId,
  onSelectConversation,
  onNewChat,
  savedCounts = { action_plan: 0, agenda: 0, report: 0 },
}) {
  const [signingOut, setSigningOut] = useState(false)
  const [conversations, setConversations] = useState([])

  const userInitial = session?.user?.email?.[0]?.toUpperCase() || 'T'
  const userEmail = session?.user?.email || 'Teacher'
  const isAdmin = session?.user?.email === 'edvisejhu@gmail.com'

  useEffect(() => {
    async function loadConversations() {
      if (!session?.user?.id || session.user.id === 'demo') {
        setConversations([])
        return
      }
      const token = session?.access_token
      if (!token) {
        console.warn('Sidebar: no access_token on session — cannot list conversations')
        setConversations([])
        return
      }
      try {
        const convos = await listConversations(token)
        const list = Array.isArray(convos) ? convos : []
        setConversations(list)
      } catch (e) {
        console.error('Failed to load conversations:', e?.message || e)
        setConversations([])
      }
    }
    if (session?.user) {
      loadConversations()
    }
  }, [session?.access_token, session?.user?.id, refreshKey])

  async function handleSignOut() {
    setSigningOut(true)
    localStorage.removeItem('edvise_demo_session')
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  return (
    <>
      <div className="sidebar-top">
        <div className="logo">
          <div className="logo-mark">Ev</div>
          <span className="logo-name">EdVise</span>
        </div>
        <button
          type="button"
          className="new-chat-btn"
          onClick={() => onNewChat?.()}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New conversation
        </button>
      </div>

      <div className="sidebar-scroll">
        <div className="sb-label">My Library</div>
        <div
          className={`nav-item${mainView === 'library-all' ? ' active' : ''}`}
          onClick={() => setMainView('library-all')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          All documents
        </div>
        <div
          className={`nav-item${mainView === 'library-strategy' ? ' active' : ''}`}
          onClick={() => setMainView('library-strategy')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          Strategy & plans
        </div>
        <div
          className={`nav-item${mainView === 'library-reports' ? ' active' : ''}`}
          onClick={() => setMainView('library-reports')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          Reports & data
        </div>
        <div
          className={`nav-item${mainView === 'library-pending' ? ' active' : ''}`}
          onClick={() => setMainView('library-pending')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          Pending approval
          <span className="nav-badge">2</span>
        </div>

        <div className="sb-label" style={{ marginTop: 8 }}>My Actions</div>
        <div
          className={`nav-item${mainView === 'actions-plans' ? ' active' : ''}`}
          onClick={() => setMainView('actions-plans')}
          style={{ cursor: 'pointer' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          Action plans
          {savedCounts.action_plan > 0 && <span className="nav-badge">{savedCounts.action_plan}</span>}
        </div>
        <div
          className={`nav-item${mainView === 'actions-agendas' ? ' active' : ''}`}
          onClick={() => setMainView('actions-agendas')}
          style={{ cursor: 'pointer' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Meeting agendas
          {savedCounts.agenda > 0 && <span className="nav-badge">{savedCounts.agenda}</span>}
        </div>
        <div
          className={`nav-item${mainView === 'actions-reports' ? ' active' : ''}`}
          onClick={() => setMainView('actions-reports')}
          style={{ cursor: 'pointer' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          Reports
          {savedCounts.report > 0 && <span className="nav-badge">{savedCounts.report}</span>}
        </div>

        <div className="sb-label" style={{ marginTop: 8 }}>Account</div>
        {isAdmin && (
          <div
            className={`nav-item${mainView === 'kb' ? ' active' : ''}`}
            onClick={() => setMainView('kb')}
            style={{ cursor: 'pointer' }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            Knowledge base
          </div>
        )}
        <div
          className={`nav-item${mainView === 'settings' ? ' active' : ''}`}
          onClick={() => setMainView('settings')}
          style={{ cursor: 'pointer' }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
          </svg>
          Settings
        </div>

        <div className="sb-label" style={{ marginTop: 16 }}>Recent</div>
        {conversations.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>
            No conversations yet
          </div>
        ) : (
          conversations
            .slice()
            .reverse()
            .map((c) => (
              <div
                key={c.id}
                className={`history-item${highlightConversationId === c.id ? ' active' : ''}`}
                onClick={() => onSelectConversation?.(c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelectConversation?.(c.id)
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title || 'Untitled'}
                </span>
              </div>
            ))
        )}

        <div style={{ height: 12 }} />
      </div>

      <div className="sidebar-footer">
        <div className="user-row" onClick={handleSignOut} title="Sign out">
          <div className="avatar">{userInitial}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="user-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {userEmail}
            </div>
            <div className="user-role">
              {signingOut ? 'Signing out…' : 'Teacher · Sign out →'}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
