import { useRef } from 'react'
import { Bar } from 'react-chartjs-2'
import { chartRefToPngDataUrl, downloadChartPng } from '../../lib/chartRegister'
import { NextActions } from '../viz/shared'

const TIER_COLORS = {
  critical: 'var(--risk-critical)',
  high: 'var(--risk-high)',
  moderate: 'var(--risk-moderate)',
  on_track: 'var(--risk-ontrack)',
}

const GRADE_PALETTE = ['#1565c0', '#d32f2f', '#2e7d32', '#7b1fa2', '#f57c00', '#5c6bc0', '#00838f']

export default function GradeComparisonCard({ data, onAddToReport, onAction }) {
  const chartRef = useRef(null)
  const breakdown = data?.grade_breakdown
  if (!breakdown || Object.keys(breakdown).length === 0) return null

  const grades = Object.keys(breakdown).sort()

  const gradeChartData = {
    labels: ['Critical', 'High', 'Moderate', 'On Track'],
    datasets: grades.map((grade, i) => ({
      label: `Grade ${grade}`,
      data: [
        breakdown[grade].critical ?? 0,
        breakdown[grade].high ?? 0,
        breakdown[grade].moderate ?? 0,
        breakdown[grade].on_track ?? 0,
      ],
      backgroundColor: GRADE_PALETTE[i % GRADE_PALETTE.length],
      borderRadius: 4,
    })),
  }

  const gradeChartOptions = {
    plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } },
    scales: {
      x: { grid: { display: false } },
      y: { grid: { color: '#f0f0f0' }, ticks: { font: { size: 11 } } },
    },
    maintainAspectRatio: false,
  }

  function handleAddToReport() {
    const imageUrl = chartRefToPngDataUrl(chartRef)
    onAddToReport?.({ type: 'grade_comparison', data, imageUrl })
  }

  return (
    <div className="analysis-card">
      <div className="analysis-card-header">
        <div className="analysis-card-header-text">
          <span className="analysis-card-title">By Grade Level</span>
          <span className="analysis-card-sub">{grades.length} grades</span>
        </div>
        <div className="analysis-card-header-actions">
          <button type="button" className="add-to-report-btn" onClick={() => downloadChartPng(chartRef, 'edvise-grade-comparison.png')}>
            Export PNG
          </button>
          {onAddToReport && (
            <button type="button" className="add-to-report-btn" onClick={handleAddToReport}>
              + Add to report
            </button>
          )}
        </div>
      </div>
      <div className="analysis-card-body">
        <div style={{ height: 200 }}>
          <Bar ref={chartRef} data={gradeChartData} options={gradeChartOptions} />
        </div>

        <div className="grade-grid">
          {grades.map(grade => {
            const g = breakdown[grade]
            const gtotal = g.total || 1
            const tiers = [
              { key: 'critical', label: 'Critical' },
              { key: 'high', label: 'High' },
              { key: 'moderate', label: 'Moderate' },
              { key: 'on_track', label: 'On Track' },
            ]
            const criticalPct = Math.round(((g.critical || 0) / gtotal) * 100)

            return (
              <div key={grade} className="grade-card">
                <div className="grade-card-header">
                  <span className="grade-card-name">Grade {grade}</span>
                  {criticalPct >= 10 && (
                    <span className="grade-card-badge">⚠ {criticalPct}% critical</span>
                  )}
                  <div className="grade-card-sub">{g.total} students · {g.pct_flagged}% flagged</div>
                </div>
                <div className="grade-card-body">
                  <div className="gc-label">Risk Tiers</div>
                  {tiers.map(t => {
                    const count = g[t.key] || 0
                    const pct = Math.round((count / gtotal) * 100)
                    return (
                      <div key={t.key} className="tier-row">
                        <span className={`tier-name ${t.key}`}>{t.label}</span>
                        <div className="tier-bar">
                          <div className="tier-fill" style={{ width: `${pct}%`, background: TIER_COLORS[t.key] }} />
                        </div>
                        <span className="tier-val">{count} ({pct}%)</span>
                      </div>
                    )
                  })}

                  {g.indicators && (
                    <div className="ind-grid">
                      <div className="ind-box">
                        <div className="ind-name">Chronic abs.</div>
                        <div className="ind-val">{g.indicators.chronic_absence || 0}</div>
                        <div className="ind-pct">{Math.round(((g.indicators.chronic_absence || 0) / gtotal) * 100)}%</div>
                      </div>
                      <div className="ind-box">
                        <div className="ind-name">Severe abs.</div>
                        <div className="ind-val">{g.indicators.severe_absence || 0}</div>
                        <div className="ind-pct">{Math.round(((g.indicators.severe_absence || 0) / gtotal) * 100)}%</div>
                      </div>
                      <div className="ind-box">
                        <div className="ind-name">Susp.</div>
                        <div className="ind-val">{g.indicators.suspensions || 0}</div>
                        <div className="ind-pct">{Math.round(((g.indicators.suspensions || 0) / gtotal) * 100)}%</div>
                      </div>
                      <div className="ind-box">
                        <div className="ind-name">Acad. Fail</div>
                        <div className="ind-val">{g.indicators.academic_failures || 0}</div>
                        <div className="ind-pct">{Math.round(((g.indicators.academic_failures || 0) / gtotal) * 100)}%</div>
                      </div>
                    </div>
                  )}

                  {g.all_3_flags > 0 && (
                    <div className="all-flags-box">
                      <div className="all-flags-label">All 3 risk flags</div>
                      <div className="all-flags-val">{g.all_3_flags}</div>
                      <div className="all-flags-sub">students need immediate support</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {(() => {
          const gradeRows = data?.grades?.length
            ? data.grades
            : grades.map((g) => ({
                label: `Grade ${g}`,
                flagged_pct: breakdown[g]?.pct_flagged ?? 0,
              }))
          if (!gradeRows.length) return null
          const topGrade = gradeRows.reduce(
            (a, b) => ((b.flagged_pct || 0) > (a.flagged_pct || 0) ? b : a),
            gradeRows[0] || {},
          )
          const gradeNum = topGrade?.label?.replace('Grade ', '') || ''
          return (
            <NextActions
              actions={[
                { label: `Which subgroups are driving ${topGrade?.label || 'the highest grade'}'s failure rate? →`, type: 'subgroup_grade', grade: gradeNum },
                { label: `Show me ${topGrade?.label || 'Grade'} students with all 3 flags`, type: 'student_list', tier: 'triple', grade: gradeNum },
                { label: 'Compare SEL scores across grades', type: 'sel' },
              ]}
              onAction={onAction}
            />
          )
        })()}
      </div>
    </div>
  )
}
