import { useState, useRef } from 'react'
import { uploadDocument } from '../lib/api'

const FOLDERS = [
  { id: 'all', label: 'All Documents', icon: '📁' },
  { id: 'global', label: 'Knowledge Base', icon: '📚' },
  { id: 'school', label: 'School Docs', icon: '🏫' },
  { id: 'pending', label: 'Pending Review', icon: '⏳' },
]

const SAMPLE_DOCS = [
  { id: 1, name: 'Chronic Absenteeism Guide', type: 'PDF', scope: 'global', pages: 24, addedBy: 'EdVise', status: 'in-kb', date: 'Jan 2024' },
  { id: 2, name: 'SEL Framework Overview', type: 'PDF', scope: 'global', pages: 18, addedBy: 'EdVise', status: 'in-kb', date: 'Jan 2024' },
  { id: 3, name: 'Tiered Intervention Strategies', type: 'PDF', scope: 'global', pages: 31, addedBy: 'EdVise', status: 'in-kb', date: 'Feb 2024' },
  { id: 4, name: 'School Attendance Policy', type: 'DOCX', scope: 'school', pages: 5, addedBy: 'You', status: 'pending', date: 'Mar 2024' },
]

const STATUS_CLASSES = {
  'in-kb': 'status-in-kb',
  'pending': 'status-pending',
  'new': 'status-new',
}

const STATUS_LABELS = {
  'in-kb': 'In KB',
  'pending': 'Pending',
  'new': 'New',
}

export default function Library({ session }) {
  const [activeFolder, setActiveFolder] = useState('all')
  const [filter, setFilter] = useState('all')
  const [docs, setDocs] = useState(SAMPLE_DOCS)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const fileInputRef = useRef(null)

  const filtered = docs.filter(d => {
    if (activeFolder !== 'all' && d.scope !== activeFolder) return false
    if (filter === 'in-kb') return d.status === 'in-kb'
    if (filter === 'pending') return d.status === 'pending'
    return true
  })

  async function handleUpload(file) {
    setUploading(true)
    setUploadError(null)
    try {
      await uploadDocument(file, activeFolder === 'all' ? 'school' : activeFolder)
      setDocs(prev => [...prev, {
        id: Date.now(),
        name: file.name.replace(/\.[^.]+$/, ''),
        type: file.name.split('.').pop().toUpperCase(),
        scope: activeFolder === 'all' ? 'school' : activeFolder,
        pages: '—',
        addedBy: 'You',
        status: 'new',
        date: new Date().toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      }])
    } catch (e) {
      setUploadError(e.message)
    } finally {
      setUploading(false)
    }
  }

  const userInitial = session?.user?.email?.[0]?.toUpperCase() || 'T'

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="logo">
            <div className="logo-mark">E</div>
            <span className="logo-name">EdVise</span>
          </div>
        </div>
        <div className="sidebar-scroll">
          <div className="sb-label">Library</div>
          {FOLDERS.map(f => (
            <div
              key={f.id}
              className={`nav-item${activeFolder === f.id ? ' active' : ''}`}
              onClick={() => setActiveFolder(f.id)}
            >
              <span>{f.icon}</span>
              {f.label}
            </div>
          ))}
          <div className="sb-label">Navigation</div>
          <a href="/" style={{ textDecoration: 'none' }} className="nav-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 13, height: 13 }}>
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Back to Chat
          </a>
        </div>
        <div className="sidebar-footer">
          <div className="user-row">
            <div className="ev-avatar">{userInitial}</div>
            <div>
              <div className="user-name">{session?.user?.email || 'Teacher'}</div>
              <div className="user-role">Teacher</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="library-layout" style={{ flex: 1 }}>
        <div className="lib-main">
          <div className="lib-header">
            <div className="lib-school">Document Library</div>
            <div className="lib-sub">Knowledge base and school documents used by EdVise</div>
          </div>

          <div className="lib-stats">
            <div className="lib-stat">
              <div className="lib-stat-val">{docs.length}</div>
              <div className="lib-stat-label">Total docs</div>
            </div>
            <div className="lib-stat">
              <div className="lib-stat-val">{docs.filter(d => d.status === 'in-kb').length}</div>
              <div className="lib-stat-label">In knowledge base</div>
            </div>
            <div className="lib-stat">
              <div className="lib-stat-val">{docs.filter(d => d.scope === 'global').length}</div>
              <div className="lib-stat-label">Global KB</div>
            </div>
            <div className="lib-stat">
              <div className="lib-stat-val">{docs.filter(d => d.status === 'pending').length}</div>
              <div className="lib-stat-label">Pending</div>
            </div>
          </div>

          {uploadError && (
            <div className="lib-warning">⚠ {uploadError}</div>
          )}

          <div className="lib-filters">
            {['all', 'in-kb', 'pending'].map(f => (
              <button
                key={f}
                className={`lib-filter${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'in-kb' ? 'In KB' : 'Pending'}
              </button>
            ))}
          </div>

          <div className="lib-table">
            <div className="lib-table-head">
              <span>Document</span>
              <span>Added by</span>
              <span>Scope</span>
              <span>Date</span>
              <span>Status</span>
            </div>
            {filtered.map(doc => (
              <div key={doc.id} className="lib-table-row">
                <div className="lib-doc-name">
                  <span className="lib-doc-type">{doc.type}</span>
                  <div>
                    <div>{doc.name}</div>
                    {doc.pages !== '—' && <div className="lib-doc-pages">{doc.pages} pages</div>}
                  </div>
                </div>
                <div className="lib-added-by">
                  <div className="lib-added-avatar">{doc.addedBy[0]}</div>
                  {doc.addedBy}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {doc.scope === 'global' ? 'Global KB' : 'School'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{doc.date}</span>
                <span className={`status-badge ${STATUS_CLASSES[doc.status] || 'status-new'}`}>
                  {STATUS_LABELS[doc.status] || doc.status}
                </span>
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: '20px 14px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                No documents in this category.
              </div>
            )}
          </div>

          <div className="lib-upload-bar">
            <button
              className="lib-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? '⏳ Uploading…' : '+ Upload Document'}
            </button>
            <span className="lib-file-types">Supports PDF, DOCX, TXT</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files[0]) handleUpload(e.target.files[0]); e.target.value = '' }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
