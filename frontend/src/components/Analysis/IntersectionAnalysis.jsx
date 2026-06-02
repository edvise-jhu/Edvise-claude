function IntersectRow({ label, count, pct, color = 'bg-primary' }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-48 text-xs text-gray-700 shrink-0">{label}</div>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} rounded-full h-2`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="text-xs font-medium text-gray-700 w-20 text-right">{count} ({pct}%)</div>
    </div>
  )
}

export default function IntersectionAnalysis({ data }) {
  if (!data) return null

  const { single_flags, two_flags, all_3_flags, inclusive_totals, severe_co_occurring } = data

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        <strong>{data.total_at_risk}</strong> students flagged across all risk indicators.
      </p>

      <section>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Single Flag Only</h4>
        <div className="space-y-2">
          <IntersectRow label="Academic failure only" {...single_flags.academic_only} color="bg-blue-400" />
          <IntersectRow label="Chronic absence only" {...single_flags.absent_only} color="bg-yellow-400" />
          <IntersectRow label="Suspension only" {...single_flags.suspension_only} color="bg-orange-400" />
        </div>
      </section>

      <section>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Two Flags</h4>
        <div className="space-y-2">
          <IntersectRow label="Absence + Academic" {...two_flags.absent_academic} color="bg-orange-500" />
          <IntersectRow label="Suspension + Academic" {...two_flags.suspension_academic} color="bg-red-400" />
          <IntersectRow label="Absence + Suspension" {...two_flags.absent_suspension} color="bg-red-500" />
        </div>
      </section>

      <section>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">All 3 Flags</h4>
        <IntersectRow label="Absence + Suspension + Academic" {...all_3_flags} color="bg-red-700" />
      </section>

      {severe_co_occurring && severe_co_occurring.total_severe > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Severe Absence Co-occurrence ({severe_co_occurring.total_severe} students)
          </h4>
          <div className="space-y-2">
            <IntersectRow label="Severe absence + Academic" {...severe_co_occurring.with_academic} color="bg-purple-500" />
            <IntersectRow label="Severe absence + Suspension" {...severe_co_occurring.with_suspension} color="bg-purple-600" />
            <IntersectRow label="Severe absence + Both" {...severe_co_occurring.with_both} color="bg-purple-800" />
          </div>
        </section>
      )}
    </div>
  )
}
