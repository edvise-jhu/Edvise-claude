export default function GradeComparison({ gradeBreakdown }) {
  if (!gradeBreakdown || Object.keys(gradeBreakdown).length === 0) {
    return <p className="text-sm text-gray-400">No grade-level data available.</p>
  }

  const grades = Object.entries(gradeBreakdown).sort(([a], [b]) => {
    const na = parseInt(a), nb = parseInt(b)
    return isNaN(na) || isNaN(nb) ? a.localeCompare(b) : na - nb
  })

  const maxPct = Math.max(...grades.map(([, g]) => g.pct_flagged || 0), 1)

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-brand">Grade-Level Comparison</h3>
      {grades.map(([grade, g]) => (
        <div key={grade} className="bg-bg rounded-xl border border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-gray-800">Grade {grade}</span>
            <span className="text-xs text-gray-500">{g.total} students</span>
          </div>

          {/* At-risk bar */}
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 bg-gray-100 rounded-full h-2">
              <div
                className="bg-accent rounded-full h-2"
                style={{ width: `${(g.pct_flagged / maxPct) * 100}%` }}
              />
            </div>
            <span className="text-xs font-medium text-gray-700 w-16 text-right">{g.pct_flagged}% flagged</span>
          </div>

          {/* Tier pills */}
          <div className="flex gap-2 flex-wrap">
            {g.critical > 0 && (
              <span className="text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5">
                {g.critical} critical
              </span>
            )}
            {g.high > 0 && (
              <span className="text-xs bg-orange-100 text-orange-700 rounded-full px-2 py-0.5">
                {g.high} high
              </span>
            )}
            {g.moderate > 0 && (
              <span className="text-xs bg-yellow-100 text-yellow-700 rounded-full px-2 py-0.5">
                {g.moderate} moderate
              </span>
            )}
            {g.all_3_flags > 0 && (
              <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">
                {g.all_3_flags} all-3-flags
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
