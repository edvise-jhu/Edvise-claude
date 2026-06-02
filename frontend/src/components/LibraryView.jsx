import { useState, useEffect, useCallback } from 'react'
import { listDocuments, uploadDocument, downloadKbDocument, approveKbDocument } from '../lib/api'

export default function LibraryView({ filter, session, accessToken = null }) {
  const [docs, setDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState('all')
  const [uploading, setUploading] = useState(false)
  const isAdmin = session?.user?.email === 'edvisejhu@gmail.com'
  const userId = session?.user?.id || null
  const userEmail = (session?.user?.email || '').toLowerCase()

  const loadDocs = useCallback(async () => {
    setLoading(true)
    try {
      const all = await listDocuments(null, accessToken)
      if (import.meta.env.DEV) {
        console.log('Loaded docs:', all)
      }
      setDocs(Array.isArray(all) ? all : [])
    } catch (e) {
      console.error('Failed to load docs:', e)
      setDocs([])
    } finally {
      setLoading(false)
    }
  }, [accessToken])

  useEffect(() => {
    loadDocs()
  }, [filter, loadDocs])

  // Avoid stale chip filters (pdf/mine/etc.) hiding rows when switching tabs.
  useEffect(() => {
    setActiveFilter('all')
  }, [filter])

  function getFilteredDocs() {
    let filtered = docs
    if (filter === 'strategy') filtered = docs.filter((d) => d.category === 'strategy')
    else if (filter === 'reports') {
      filtered = docs.filter((d) => ['csv', 'xlsx', 'xls'].includes((d.file_type || '').toLowerCase()))
    } else if (filter === 'pending') {
      filtered = docs.filter((d) => {
        if ((d.status || '').toLowerCase() !== 'pending') return false
        if (isAdmin) return true
        // Non-admin: always show the pending docs this user uploaded.
        if (userId && d.uploaded_by === userId) return true
        const upEmail = (d.uploaded_by_email || '').toLowerCase()
        return Boolean(userEmail && upEmail && upEmail === userEmail)
      })
    }
    if (activeFilter === 'pdf') filtered = filtered.filter((d) => (d.file_type || '').toLowerCase() === 'pdf')
    else if (activeFilter === 'docx') filtered = filtered.filter((d) => (d.file_type || '').toLowerCase() === 'docx')
    else if (activeFilter === 'xlsx') {
      filtered = filtered.filter((d) => ['xlsx', 'csv'].includes((d.file_type || '').toLowerCase()))
    } else if (activeFilter === 'mine') {
      filtered = filtered.filter((d) => d.uploaded_by === session?.user?.id)
    }
    return filtered
  }

  const filteredDocs = getFilteredDocs()
  const pendingDocs = docs.filter((d) => d.status === 'pending')
  const inKBDocs = docs.filter((d) => d.status === 'approved')
  const thisTermDocs = docs.filter((d) => {
    const created = new Date(d.created_at)
    const threeMonthsAgo = new Date()
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
    return created > threeMonthsAgo
  })

  async function handleDownloadDoc(doc) {
    if (doc.status !== 'approved') {
      window.alert('This document is not approved yet, so it cannot be downloaded.')
      return
    }
    if (!accessToken) {
      window.alert('Please sign in to download.')
      return
    }
    try {
      await downloadKbDocument(doc.id, accessToken)
    } catch (e) {
      console.error(e)
      window.alert(e.message || 'Download failed')
    }
  }

  async function handleApproveDoc(docId) {
    if (!accessToken) return
    try {
      await approveKbDocument(docId, accessToken)
      await loadDocs()
    } catch (e) {
      console.error(e)
      window.alert(e.message || 'Approve failed')
    }
  }

  async function handleUpload(file) {
    if (!accessToken) {
      alert('Please sign in to upload documents.')
      return
    }
    setUploading(true)
    try {
      if (import.meta.env.DEV) {
        console.log('Uploading file:', file.name)
      }
      const result = await uploadDocument(file, 'school', null, accessToken)
      if (import.meta.env.DEV) {
        console.log('Upload result:', result)
      }
      await loadDocs()
    } catch (e) {
      console.error('Upload failed:', e)
      alert(`Upload failed: ${e.message || String(e)}`)
    } finally {
      setUploading(false)
    }
  }

  function getStatusBadge(status) {
    const styles = {
      approved: { background: '#edf6f8', color: '#1b6070', label: 'In KB' },
      pending: { background: '#fdf3e1', color: '#7a5c10', label: 'Pending' },
      default: { background: '#f0faf0', color: '#2e7d32', label: 'Just added' },
    }
    const s = styles[status] || styles.default
    return (
      <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500, background: s.background, color: s.color }}>
        {s.label}
      </span>
    )
  }

  function getFileIcon(fileType) {
    const colors = { pdf: '#e53935', docx: '#1565c0', xlsx: '#2e7d32', csv: '#2e7d32', xls: '#2e7d32' }
    const ft = (fileType || 'file').toLowerCase()
    return (
      <div style={{ width: 32, height: 32, borderRadius: 6, background: colors[ft] || '#e4e9f2', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white', flexShrink: 0 }}>
        {(ft || 'FILE').toUpperCase().slice(0, 4)}
      </div>
    )
  }

  const titleMap = { all: 'All documents', strategy: 'Strategy & plans', reports: 'Reports & data', pending: 'Pending approval' }

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: 28,
        minHeight: 0,
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--bg, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 28, height: 28, background: '#edf6f8', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🏫</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#2A3B7C' }}>{session?.user?.email?.split('@')[0] || 'My School'}</div>
              <div style={{ fontSize: 11, color: '#7a89b8' }}>{titleMap[filter]} · {filteredDocs.length} total · last updated today</div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ padding: '7px 14px', border: '1px solid #e4e9f2', borderRadius: 8, background: 'white', fontSize: 12, fontWeight: 500, color: '#2A3B7C', cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif' }}>
            💬 Chat with docs ↗
          </button>
          <label style={{ padding: '7px 14px', border: 'none', borderRadius: 8, background: '#3E94A5', fontSize: 12, fontWeight: 500, color: 'white', cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif' }}>
            {uploading ? 'Uploading…' : '↑ Upload'}
            <input
              type="file"
              accept=".pdf,.docx,.xlsx,.csv,.xls"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) {
                  void handleUpload(f)
                  e.target.value = ''
                }
              }}
              disabled={uploading}
            />
          </label>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Documents', value: docs.length },
          { label: 'Added this term', value: thisTermDocs.length },
          { label: 'Pending approval', value: pendingDocs.length },
          { label: 'Live in KB', value: inKBDocs.length },
        ].map((tile) => (
          <div key={tile.label} style={{ background: '#f7f9fc', border: '1px solid #e4e9f2', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: '#2A3B7C' }}>{tile.value}</div>
            <div style={{ fontSize: 11, color: '#7a89b8', marginTop: 2 }}>{tile.label}</div>
          </div>
        ))}
      </div>

      {pendingDocs.length > 0 && (
        <div style={{ background: '#fdf3e1', border: '1px solid #f5dfa0', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
          <span>⏳</span>
          <div>
            <div style={{ fontWeight: 500, color: '#7a5c10' }}>Waiting for administrator approval</div>
            {pendingDocs.map((d) => (
              <div key={d.id} style={{ color: '#a07820', marginTop: 2 }}>
                📄 {d.filename} · Low similarity · uploaded {new Date(d.created_at).toLocaleDateString()}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', 'pdf', 'docx', 'xlsx', 'mine'].map((f) => (
          <button key={f} type="button" onClick={() => setActiveFilter(f)} style={{ padding: '5px 12px', borderRadius: 20, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif', background: activeFilter === f ? '#3E94A5' : 'white', color: activeFilter === f ? 'white' : '#7a89b8', borderColor: activeFilter === f ? '#3E94A5' : '#e4e9f2' }}>
            {f === 'all' ? 'All' : f === 'mine' ? 'Uploaded by me' : f.toUpperCase()}
          </button>
        ))}
        <select style={{ marginLeft: 'auto', padding: '5px 10px', border: '1px solid #e4e9f2', borderRadius: 7, fontSize: 12, fontFamily: 'Inter, system-ui, sans-serif', color: '#2A3B7C', outline: 'none' }}>
          <option>Newest first</option>
          <option>Oldest first</option>
        </select>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: '#7a89b8' }}>Loading...</div>
      ) : filteredDocs.length === 0 ? (
        <div style={{ fontSize: 13, color: '#7a89b8', padding: '40px 0', textAlign: 'center' }}>No documents yet. Upload your first document above.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e4e9f2' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Document</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Added by</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Date</th>
              <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Status</th>
              <th style={{ padding: '8px 12px' }} />
            </tr>
          </thead>
          <tbody>
            {filteredDocs.map((doc) => (
              <tr key={doc.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                <td style={{ padding: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {getFileIcon(doc.file_type || doc.filename?.split('.').pop())}
                    <div>
                      <div style={{ fontWeight: 500, color: doc.status === 'pending' ? '#a07820' : '#2A3B7C' }}>{doc.filename}</div>
                      <div style={{ fontSize: 11, color: '#7a89b8', marginTop: 1 }}>{(doc.file_type || '').toUpperCase()}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '12px' }}>
                  <div style={{ width: 26, height: 26, background: '#2A3B7C', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 10, fontWeight: 600 }}>
                    {(doc.uploaded_by_email || 'U')[0]?.toUpperCase() || 'U'}
                  </div>
                </td>
                <td style={{ padding: '12px', color: '#7a89b8', fontSize: 12 }}>{new Date(doc.created_at).toLocaleDateString()}</td>
                <td style={{ padding: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {getStatusBadge(doc.status)}
                    {doc.status === 'pending' && isAdmin && (
                      <button
                        type="button"
                        onClick={() => void handleApproveDoc(doc.id)}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          border: '1px solid #3E94A5',
                          background: '#edf6f8',
                          color: '#1b6070',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Approve
                      </button>
                    )}
                  </div>
                </td>
                <td style={{ padding: '12px' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" style={{ width: 26, height: 26, border: '1px solid #e4e9f2', borderRadius: 6, background: 'white', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Chat with doc">💬</button>
                    <a
                      href="#download"
                      onClick={(e) => {
                        e.preventDefault()
                        void handleDownloadDoc(doc)
                      }}
                      title="Download"
                      style={{
                        width: 26,
                        height: 26,
                        border: '1px solid #e4e9f2',
                        borderRadius: 6,
                        background: 'white',
                        cursor: 'pointer',
                        fontSize: 12,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        textDecoration: 'none',
                        color: '#2A3B7C',
                        boxSizing: 'border-box',
                      }}
                    >
                      ↓
                    </a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
