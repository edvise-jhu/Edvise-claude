/**
 * Wraps SELAnalysis with the shared chat card chrome. Chat uses this for message types
 * `sel` and `sel_fallback` (see MessageList InlineCard).
 */
import SELAnalysis from '../Analysis/SELAnalysis'

export default function SELFallbackCard({ data }) {
  if (!data) return null

  return (
    <div className="analysis-card">
      <div className="analysis-card-header">
        <div className="analysis-card-header-text">
          <span className="analysis-card-title">SEL Factor Analysis</span>
          {!data.available && (
            <span className="analysis-card-sub">No SEL survey columns mapped</span>
          )}
        </div>
      </div>
      <div className="analysis-card-body" style={{ fontSize: 12 }}>
        <SELAnalysis data={data} />
      </div>
    </div>
  )
}
