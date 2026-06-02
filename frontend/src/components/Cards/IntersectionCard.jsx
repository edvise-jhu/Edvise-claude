export default function IntersectionCard({ data, onAddToReport }) {
  if (!data) return null
  const total = data.total_at_risk || 1

  function bar(pct) {
    return (
      <div className="int-bar-wrap">
        <div className="int-bar" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    )
  }

  const single = data.single_flags || {}
  const two = data.two_flags || {}
  const all3 = data.all_3_flags || data.all_three || {}

  const singleRows = [
    { label: 'Academic failure only', flags: [<span key="a" className="flag-tag tag-acad">Acad</span>], ...single.academic_only },
    { label: 'Chronic absence only', flags: [<span key="b" className="flag-tag tag-absent">Absent</span>], ...single.absent_only },
    { label: 'Suspension only', flags: [<span key="c" className="flag-tag tag-susp">Susp</span>], ...single.suspension_only },
  ]

  const twoRows = [
    { label: 'Absence + academics', flags: [<span key="a" className="flag-tag tag-absent">Absent</span>, <span key="b" className="flag-tag tag-acad">Acad</span>], ...two.absent_academic },
    { label: 'Suspension + academics', flags: [<span key="a" className="flag-tag tag-susp">Susp</span>, <span key="b" className="flag-tag tag-acad">Acad</span>], ...two.suspension_academic },
    { label: 'Absence + suspension', flags: [<span key="a" className="flag-tag tag-absent">Absent</span>, <span key="b" className="flag-tag tag-susp">Susp</span>], ...two.absent_suspension },
  ]

  function Row({ label, flags, count = 0, pct = 0, highlight }) {
    return (
      <div className={`int-row${highlight ? ' all-3-row' : ''}`}>
        <span className="int-label">
          {flags} {label}
        </span>
        {bar(pct)}
        <span className="int-count">{count}</span>
        <span className="int-pct">{pct}%</span>
      </div>
    )
  }

  return (
    <div className="analysis-card">
      <div className="analysis-card-header">
        <div className="analysis-card-header-text">
          <span className="analysis-card-title">Risk Factor Intersections</span>
          <span className="analysis-card-sub">{data.total_at_risk} at-risk students</span>
        </div>
        {onAddToReport && (
          <button
            type="button"
            className="add-to-report-btn"
            onClick={() => onAddToReport({ type: 'intersection', data })}
          >
            + Add to report
          </button>
        )}
      </div>
      <div className="analysis-card-body">
        <div className="int-section-title">Single flag</div>
        {singleRows.map((r, i) => <Row key={i} {...r} />)}

        <div className="int-section-title">Two flags</div>
        {twoRows.map((r, i) => <Row key={i} {...r} />)}

        {all3.count > 0 && (
          <>
            <div className="int-section-title">All three flags</div>
            <Row
              label="Absence + academics + suspension"
              flags={[
                <span key="a" className="flag-tag tag-absent">Absent</span>,
                <span key="b" className="flag-tag tag-acad">Acad</span>,
                <span key="c" className="flag-tag tag-susp">Susp</span>,
              ]}
              count={all3.count}
              pct={all3.pct}
              highlight
            />
          </>
        )}

        {data.severe_co_occurring?.total_severe > 0 && (
          <div>
            <div className="int-section-title">
              Severe absence (20%+) — co-occurring flags
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
              Among the {data.severe_co_occurring.total_severe} severely absent students
            </div>
            <div className="int-row">
              <span className="int-label">
                <span className="flag-tag tag-acad">Also have academic failure</span>
              </span>
              <span className="int-count">{data.severe_co_occurring.with_academic.count}</span>
              <div className="int-bar-wrap">
                <div className="int-bar" style={{ width: `${Math.min(data.severe_co_occurring.with_academic.pct, 100)}%`, background: '#d32f2f' }} />
              </div>
              <span className="int-pct">{data.severe_co_occurring.with_academic.pct}%</span>
            </div>
            <div className="int-row">
              <span className="int-label">
                <span className="flag-tag tag-susp">Also have a suspension</span>
              </span>
              <span className="int-count">{data.severe_co_occurring.with_suspension.count}</span>
              <div className="int-bar-wrap">
                <div className="int-bar" style={{ width: `${Math.min(data.severe_co_occurring.with_suspension.pct, 100)}%`, background: '#e65100' }} />
              </div>
              <span className="int-pct">{data.severe_co_occurring.with_suspension.pct}%</span>
            </div>
            <div className="int-row">
              <span className="int-label">
                <span className="flag-tag tag-acad">Have both suspension + academic failure</span>
              </span>
              <span className="int-count">{data.severe_co_occurring.with_both.count}</span>
              <div className="int-bar-wrap">
                <div className="int-bar" style={{ width: `${Math.min(data.severe_co_occurring.with_both.pct, 100)}%`, background: '#d32f2f' }} />
              </div>
              <span className="int-pct">{data.severe_co_occurring.with_both.pct}%</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
