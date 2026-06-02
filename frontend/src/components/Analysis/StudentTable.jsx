const TIER_COLORS = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  moderate: 'bg-yellow-100 text-yellow-700',
  on_track: 'bg-green-100 text-green-700',
}

export default function StudentTable({ students, filterTier, onFilterChange }) {
  if (!students || students.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-gray-400">No students found for this tier.</p>
      </div>
    )
  }

  const cols = students.length > 0
    ? Object.keys(students[0]).filter(k => !['chronic_absent', 'severe_absent', 'has_suspension', 'has_academic_failure'].includes(k))
    : []

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Filter:</span>
        {['critical', 'high', 'moderate'].map(tier => (
          <button
            key={tier}
            onClick={() => onFilterChange(tier)}
            className={`text-xs px-3 py-1 rounded-full transition-colors ${
              filterTier === tier
                ? TIER_COLORS[tier] + ' font-semibold'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {tier.charAt(0).toUpperCase() + tier.slice(1)}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="text-xs w-full">
          <thead>
            <tr className="bg-bg border-b border-border">
              {cols.map(col => (
                <th key={col} className="px-3 py-2 text-left text-gray-500 font-medium whitespace-nowrap">
                  {col.replace(/_/g, ' ')}
                </th>
              ))}
              <th className="px-3 py-2 text-left text-gray-500 font-medium">Flags</th>
            </tr>
          </thead>
          <tbody>
            {students.map((student, i) => (
              <tr key={i} className="border-b border-border last:border-0 hover:bg-bg transition-colors">
                {cols.map(col => (
                  <td key={col} className="px-3 py-2 text-gray-700 whitespace-nowrap">
                    {col === 'risk_tier'
                      ? <span className={`px-2 py-0.5 rounded-full font-medium ${TIER_COLORS[student[col]] || ''}`}>{student[col]}</span>
                      : col === 'days_missed_pct'
                        ? `${Number(student[col] || 0).toFixed(1)}%`
                        : String(student[col] ?? '–')}
                  </td>
                ))}
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {student.has_academic_failure && <span title="Academic failure" className="w-4 h-4 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center text-[10px]">A</span>}
                    {student.chronic_absent && <span title="Chronic absence" className="w-4 h-4 rounded-full bg-yellow-200 text-yellow-700 flex items-center justify-center text-[10px]">C</span>}
                    {student.has_suspension && <span title="Suspension" className="w-4 h-4 rounded-full bg-orange-200 text-orange-700 flex items-center justify-center text-[10px]">S</span>}
                    {student.severe_absent && <span title="Severe absence" className="w-4 h-4 rounded-full bg-red-200 text-red-700 flex items-center justify-center text-[10px]">!</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">Showing up to 50 students, sorted by days missed.</p>
    </div>
  )
}
