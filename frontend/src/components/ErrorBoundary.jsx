import React from 'react'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // Surface the error in the console for debugging.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const msg = this.state.error?.message || String(this.state.error || 'Unknown error')
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif' }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Edvise hit a UI error.</div>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 12 }}>
          Open DevTools → Console for the full stack trace.
        </div>
        <pre style={{ fontSize: 12, background: '#f6f8fa', padding: 12, borderRadius: 8, overflowX: 'auto' }}>
          {msg}
        </pre>
      </div>
    )
  }
}

