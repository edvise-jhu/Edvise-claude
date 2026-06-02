const TIERS = [
  { key: 'critical', label: 'Critical', color: 'bg-red-100 text-red-700 border-red-200', dot: 'bg-red-500' },
  { key: 'high', label: 'High Risk', color: 'bg-orange-100 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  { key: 'moderate', label: 'Moderate', color: 'bg-yellow-100 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
  { key: 'on_track', label: 'On Track', color: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500' },
]

const FLAG_LABELS = {
  academic_failures: 'Academic Failures',
  chronic_absence: 'Chronic Absence (10%+)',
  behavior: 'Suspensions',
  severe_absence: 'Severe Absence (20%+)',
}

export default function RiskOverview({ data }) {
  if (!data) return null

  const total = data.total || 1

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-brand mb-3">Risk Distribution — {data.total} students total</h3>
        <div className="grid grid-cols-2 gap-3">
          {TIERS.map(tier => {
            const count = data[tier.key] || 0
            const pct = Math.round((count / total) * 100)
            return (
              <div key={tier.key} className={`rounded-xl border px-4 py-3 ${tier.color}`}>
                <div className="flex items-center gap-2 mb-1">
                  <div className={`w-2 h-2 rounded-full ${tier.dot}`} />
                  <span className="text-xs font-semibold uppercase tracking-wide">{tier.label}</span>
                </div>
                <div className="text-2xl font-bold">{count}</div>
                <div className="text-xs opacity-70 mt-0.5">{pct}% of students</div>
              </div>
            )
          })}
        </div>
      </div>

      {data.flags && (
        <div>
          <h3 className="text-sm font-semibold text-brand mb-3">Flag Counts</h3>
          <div className="space-y-2">
            {Object.entries(FLAG_LABELS).map(([key, label]) => {
              const count = data.flags[key] || 0
              const pct = Math.round((count / total) * 100)
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className="w-32 text-xs text-gray-600 shrink-0">{label}</div>
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-primary rounded-full h-2 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="w-12 text-xs text-right text-gray-700 font-medium">{count} ({pct}%)</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
