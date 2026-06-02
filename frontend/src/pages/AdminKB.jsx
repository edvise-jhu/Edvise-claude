import { useState, useEffect, useCallback } from 'react'
import { uploadDocument, listDocuments, deleteKbDocument } from '../lib/api'

export default function AdminKB({ accessToken = null }) {
  const [files, setFiles] = useState([])
  const [docs, setDocs] = useState([])
  const [uploading, setUploading] = useState(false)
  const [results, setResults] = useState([])
  const [progress, setProgress] = useState(0)
  const [loadingDocs, setLoadingDocs] = useState(true)

  const loadDocs = useCallback(async () => {
    if (!accessToken) {
      setDocs([])
      setLoadingDocs(false)
      return
    }
    setLoadingDocs(true)
    try {
      const rows = await listDocuments('global', accessToken)
      setDocs(Array.isArray(rows) ? rows : [])
    } catch (e) {
      console.error(e)
      setDocs([])
    } finally {
      setLoadingDocs(false)
    }
  }, [accessToken])

  useEffect(() => {
    void loadDocs()
  }, [loadDocs])

  async function handleUpload() {
    if (files.length === 0 || !accessToken) return
    setUploading(true)
    setResults([])
    const allResults = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setProgress(Math.round((i / files.length) * 100))
      try {
        const result = await uploadDocument(file, 'global', null, accessToken)
        allResults.push({
          file: file.name,
          status: 'success',
          tags: result.tags || [],
        })
      } catch (e) {
        allResults.push({
          file: file.name,
          status: 'error',
          error: e.message,
        })
      }
      setResults([...allResults])
    }

    setProgress(100)
    setUploading(false)
    setFiles([])
    await loadDocs()
  }

  async function handleDelete(docId, filename) {
    if (!accessToken) return
    if (!window.confirm(`Delete “${filename}” from the global knowledge base? This cannot be undone.`)) return
    try {
      await deleteKbDocument(docId, accessToken)
      await loadDocs()
    } catch (e) {
      window.alert(e.message || 'Delete failed')
    }
  }

  return (
    <div style={{ padding: 32, maxWidth: 880 }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: '#2A3B7C', marginBottom: 6 }}>
        Student Success Knowledge Base
      </h2>
      <p style={{ fontSize: 12, color: '#7a89b8', marginBottom: 24, lineHeight: 1.6 }}>
        Upload PDFs to the global knowledge base. Each document is automatically tagged by Claude so teachers can find
        relevant interventions.
      </p>

      <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C', marginBottom: 8 }}>Uploaded documents</div>
      {loadingDocs ? (
        <div style={{ fontSize: 13, color: '#7a89b8', marginBottom: 24 }}>Loading…</div>
      ) : docs.length === 0 ? (
        <div style={{ fontSize: 13, color: '#7a89b8', marginBottom: 24 }}>No global KB documents yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 28 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e4e9f2' }}>
              <th style={{ textAlign: 'left', padding: '8px 10px', color: '#7a89b8' }}>File</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', color: '#7a89b8' }}>Tags</th>
              <th style={{ textAlign: 'left', padding: '8px 10px', color: '#7a89b8' }}>Added</th>
              <th style={{ padding: '8px 10px', width: 72 }} />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} style={{ borderBottom: '1px solid #f5f5f5' }}>
                <td style={{ padding: '10px', color: '#2A3B7C', fontWeight: 500 }}>{d.filename}</td>
                <td style={{ padding: '10px', color: '#555', maxWidth: 360 }}>
                  {(d.tags || []).length ? (d.tags || []).join(', ') : '—'}
                </td>
                <td style={{ padding: '10px', color: '#7a89b8' }}>
                  {d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}
                </td>
                <td style={{ padding: '10px' }}>
                  <button
                    type="button"
                    onClick={() => void handleDelete(d.id, d.filename)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid #e4a8a8',
                      background: '#fff5f5',
                      color: '#a32d2d',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C', marginBottom: 8 }}>Add PDFs</div>
      <input
        type="file"
        multiple
        accept=".pdf"
        onChange={(e) => setFiles(Array.from(e.target.files || []))}
        style={{ marginBottom: 12, fontSize: 13 }}
      />

      {files.length > 0 && (
        <div style={{ fontSize: 12, color: '#7a89b8', marginBottom: 12 }}>
          {files.length} file(s) selected
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleUpload()}
        disabled={uploading || files.length === 0 || !accessToken}
        style={{
          padding: '8px 20px',
          background: uploading || files.length === 0 || !accessToken ? '#c5d4d8' : '#3E94A5',
          color: 'white',
          border: 'none',
          borderRadius: 8,
          cursor: uploading || files.length === 0 || !accessToken ? 'default' : 'pointer',
          fontSize: 13,
          fontWeight: 500,
          fontFamily: 'inherit',
        }}
      >
        {uploading ? `Uploading... ${progress}%` : 'Upload to KB'}
      </button>

      {results.length > 0 && (
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {results.map((r, i) => (
            <div
              key={i}
              style={{
                padding: '8px 12px',
                borderRadius: 7,
                background: r.status === 'success' ? '#edf6f8' : '#fff3f3',
                fontSize: 12,
                color: r.status === 'success' ? '#1b6070' : '#a32d2d',
                lineHeight: 1.5,
              }}
            >
              {r.status === 'success' ? (
                <>
                  <div>✓ {r.file}</div>
                  {r.tags.length > 0 && (
                    <div style={{ opacity: 0.7, marginTop: 2 }}>
                      Tags: {r.tags.join(', ')}
                    </div>
                  )}
                </>
              ) : (
                <div>
                  ✗ {r.file} — {r.error}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
