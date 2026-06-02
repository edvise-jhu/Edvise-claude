import { useState } from 'react'
import {
  buildCompareSubtitle,
  metricPct,
} from '../../lib/subgroupCompare'

const TAG_COLORS = {
  absent: { bg: '#FEE2E2', color: '#991B1B', border: '#FECACA' },
  behavior: { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
  academic: { bg: '#DBEAFE', color: '#1E40AF', border: '#BFDBFE' },
}

function Tag({ label, tags }) {
  const style = TAG_COLORS[tags?.[0]] || { bg: '#f0f3fa', color: '#2A3B7C', border: '#e4e9f2' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '1px 7px', borderRadius: 20, fontSize: 10, fontWeight: 700,
      background: style.bg, color: style.color,
      border: `1px solid ${style.border}`, whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function MetricPill({ label, pct, highlight }) {
  return (
    <span style={{
      fontSize: 11,
      fontWeight: 600,
      color: highlight ? '#DC2626' : '#2A3B7C',
      background: highlight ? '#FEF2F2' : '#f7f9fc',
      border: `1px solid ${highlight ? '#FECACA' : '#e4e9f2'}`,
      borderRadius: 6,
      padding: '3px 8px',
      whiteSpace: 'nowrap',
    }}>
      {label}: {pct}%
    </span>
  )
}

function SchoolWideHighlights({ highlights }) {
  const leaders = highlights?.leaders
  if (!leaders?.length) return null
  return (
    <div style={{
      margin: '12px 14px 0', padding: '8px 12px', background: '#eef8fb',
      border: '1px solid #b8dde6', borderRadius: 8, fontSize: 12, color: '#1b6070', lineHeight: 1.55,
    }}>
      <strong>School-wide (all tabs) — </strong>
      {leaders.map((l, i) => (
        <span key={l.metric.field || i}>
          {i > 0 ? ' · ' : ''}
          Highest {l.metric.label}: {l.name} ({l.tab}, {l.pct}%)
        </span>
      ))}
    </div>
  )
}

function TabHighlights({ groups, metrics }) {
  if (!metrics?.length || groups.length < 2) return null
  const tops = metrics.map((metric) => {
    const sorted = [...groups].sort((a, b) => metricPct(b, metric) - metricPct(a, metric))
    return { metric, top: sorted[0] }
  })
  return (
    <div style={{
      margin: '8px 14px 0', padding: '8px 12px', background: '#f7f9fc',
      border: '1px solid #e4e9f2', borderRadius: 8, fontSize: 12, color: '#2A3B7C', lineHeight: 1.55,
    }}>
      <strong>This tab only — </strong>
      {tops.map(({ metric, top }, i) => (
        <span key={metric.field}>
          {i > 0 ? ' · ' : ''}
          Highest {metric.label}: {top.name} ({metricPct(top, metric)}%)
        </span>
      ))}
    </div>
  )
}

function GroupAccordion({
  group, isOpen, onToggle, metrics, isGradeSubgroup = false, isTripleFlagCohort = false, isSchoolWide = false,
}) {
  const displayMetrics = isSchoolWide && metrics?.length
    ? metrics
    : [{ field: 'cohort_pct', label: 'Academic failure' }]
  const pcts = displayMetrics.map((m) => metricPct(group, m))
  const isHighRisk = isGradeSubgroup
    ? pcts[0] > 30
    : isSchoolWide
      ? pcts.some((p) => p > 30)
      : group.flagged_pct > 30
  const barValue = isGradeSubgroup
    ? (group.academic_fail_count ?? Math.round((pcts[0] || 0) / 100 * group.n))
    : group.flagged_count || 0
  const barWidth = group.n > 0 ? Math.min(100, (barValue / group.n) * 100) : 0

  return (
    <div style={{
      border: `1px solid ${isOpen ? '#3E94A5' : '#e4e9f2'}`,
      borderRadius: 10, overflow: 'hidden', marginBottom: 6,
    }}>
      <div
        onClick={onToggle}
        role="button"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px', cursor: 'pointer',
          background: isOpen ? '#f0f8fa' : 'white',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13, color: '#2A3B7C', minWidth: 120 }}>
          {group.name}
        </div>
        <div style={{ fontSize: 11, color: '#7a89b8', minWidth: 56 }}>
          n = {group.n.toLocaleString()}
        </div>
        {isSchoolWide ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {displayMetrics.map((m) => {
              const pct = metricPct(group, m)
              return (
                <MetricPill key={m.field} label={m.label} pct={pct} highlight={pct > 30} />
              )
            })}
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, maxWidth: 160, background: '#f0f3fa', borderRadius: 3, height: 7, overflow: 'hidden' }}>
              <div style={{ width: `${barWidth}%`, height: '100%', borderRadius: 3, background: isHighRisk ? '#DC2626' : '#3E94A5' }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, color: isHighRisk ? '#DC2626' : '#2A3B7C' }}>
              {isGradeSubgroup
                ? `${pcts[0]}% academic failure`
                : isTripleFlagCohort
                  ? `${group.flagged_pct ?? 0}% of cohort`
                  : `${group.flagged_pct}% flagged`}
            </span>
          </div>
        )}
        <span style={{ fontSize: 10, color: '#7a89b8' }}>{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #e4e9f2' }}>
          {group.single_flags?.length > 0 && (
            <div style={{ marginTop: 10, border: '1px solid #e4e9f2', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: '#f7f9fc', borderBottom: '1px solid #e4e9f2' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C' }}>Single flag only</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C', fontFamily: 'monospace' }}>
                  {group.single_flags.reduce((s, r) => s + r.count, 0)} · {group.single_flags.reduce((s, r) => s + r.pct, 0).toFixed(1)}%
                </div>
              </div>
              <ColHeader />
              {group.single_flags.map((row, i) => (
                <FlagRow key={i} row={row} groupN={group.n} />
              ))}
            </div>
          )}

          {group.combinations?.length > 0 && (
            <div style={{ marginTop: 6, border: '1px solid #e4e9f2', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: '#f7f9fc', borderBottom: '1px solid #e4e9f2' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C' }}>
                  {isTripleFlagCohort ? 'Higher intensity within group' : 'Combinations (2 flags)'}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C', fontFamily: 'monospace' }}>
                  {group.combinations.reduce((s, r) => s + r.count, 0)} · {group.combinations.reduce((s, r) => s + r.pct, 0).toFixed(1)}%
                </div>
              </div>
              <ColHeader />
              {group.combinations.map((row, i) => (
                <FlagRow key={i} row={row} groupN={group.n} />
              ))}
            </div>
          )}

          {group.all_three?.count > 0 && (
            <div style={{
              marginTop: 6, padding: '8px 10px',
              background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{ fontSize: 11, color: '#7a89b8', minWidth: 70 }}>All 3 flags</div>
              <div style={{ flex: 1, background: '#FECACA', borderRadius: 2, height: 10, overflow: 'hidden' }}>
                <div style={{ width: `${group.all_three.pct}%`, height: '100%', background: '#DC2626', borderRadius: 2 }} />
              </div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#DC2626', fontFamily: 'monospace', minWidth: 80, textAlign: 'right' }}>
                {group.all_three.count} · {group.all_three.pct}%
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ColHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 3px', borderBottom: '1px solid #f0f3fa' }}>
      <div style={{ width: 110, flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 9, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>% of group</div>
      <div style={{ fontSize: 9, fontWeight: 600, color: '#7a89b8', textTransform: 'uppercase', width: 80, textAlign: 'right' }}>Count · %</div>
    </div>
  )
}

function FlagRow({ row, groupN }) {
  const barPct = groupN > 0 ? (row.count / groupN) * 100 : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderBottom: '1px solid #f9fafc' }}>
      <div style={{ width: 110, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Tag label={row.label.split(' ')[0]} tags={row.tags} />
        {row.tags.length > 1 && (
          <>
            <span style={{ fontSize: 9, color: '#7a89b8' }}>+</span>
            <Tag label={row.label.split(' ').slice(-1)[0]} tags={[row.tags[1]]} />
          </>
        )}
      </div>
      <div style={{ flex: 1, background: '#f0f3fa', borderRadius: 2, height: 10, overflow: 'hidden' }}>
        <div style={{ width: `${barPct}%`, height: '100%', background: '#3E94A5', borderRadius: 2 }} />
      </div>
      <div style={{ fontSize: 11, color: '#2A3B7C', fontFamily: 'monospace', width: 80, textAlign: 'right' }}>
        {row.count} · {row.pct}%
      </div>
    </div>
  )
}

export default function SubgroupCard({ data }) {
  const categories = data?.categories || []
  const isTripleFlagCohort = data?.mode === 'triple_flag_cohort'
  const isGradeSubgroup = data?.mode === 'grade_subgroup'
  const isSchoolWide = data?.mode === 'school_wide'
  const metrics = data?.compare_metrics || []
  const [activeTab, setActiveTab] = useState(0)
  const [openGroups, setOpenGroups] = useState({ 0: true })

  if (!categories.length) return null

  const activeCategory = categories[activeTab]
  const groups = activeCategory?.groups || []
  const headerTitle = isGradeSubgroup
    ? `Grade subgroup breakdown — ${(data.grade_total ?? 0).toLocaleString()} students`
    : isTripleFlagCohort
      ? `Triple-flag cohort — ${(data.cohort_total ?? 0).toLocaleString()} students (all 3 indicators)`
      : `Subgroup analysis — ${data.total?.toLocaleString()} students`

  function toggleGroup(i) {
    setOpenGroups((prev) => ({ ...prev, [i]: !prev[i] }))
  }

  return (
    <div style={{ border: '1px solid #e4e9f2', borderRadius: 12, overflow: 'hidden', background: '#fff', marginTop: 10 }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid #e4e9f2', background: '#f7f9fc' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#2A3B7C', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {headerTitle}
        </div>
        {isSchoolWide && metrics.length > 0 && (
          <div style={{ fontSize: 11, color: '#7a89b8', marginTop: 4 }}>
            {data.compare_subtitle || buildCompareSubtitle(metrics)}
          </div>
        )}
      </div>

      {isSchoolWide && <SchoolWideHighlights highlights={data.school_wide_highlights} />}

      {data.warning && (
        <div style={{
          padding: '10px 14px',
          background: '#fff8e1',
          border: '1px solid #ffe082',
          borderRadius: 8,
          fontSize: 12,
          color: '#795548',
          margin: '12px 14px 0',
          lineHeight: 1.5,
        }}>
          ⚠ {data.warning}
        </div>
      )}

      <div style={{ display: 'flex', borderBottom: '1px solid #e4e9f2', overflowX: 'auto' }}>
        {categories.map((cat, i) => (
          <button
            key={i}
            type="button"
            onClick={() => { setActiveTab(i); setOpenGroups({ 0: true }) }}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: 'none', borderBottom: `2px solid ${activeTab === i ? '#3E94A5' : 'transparent'}`,
              color: activeTab === i ? '#3E94A5' : '#7a89b8',
              background: 'white', whiteSpace: 'nowrap',
            }}
          >
            {cat.tab_label}
          </button>
        ))}
      </div>

      {isSchoolWide && <TabHighlights groups={groups} metrics={metrics} />}

      {activeCategory?.equity_note && (
        <div style={{
          margin: '12px 14px 0', padding: '8px 12px',
          background: isTripleFlagCohort || isGradeSubgroup ? '#f0f8fa' : '#FEF2F2',
          border: isTripleFlagCohort || isGradeSubgroup ? '1px solid #b8dde6' : '1px solid #FECACA',
          borderRadius: 8, display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ color: isTripleFlagCohort || isGradeSubgroup ? '#3E94A5' : '#DC2626', fontSize: 12, flexShrink: 0 }}>●</span>
          <div style={{ fontSize: 12, color: isTripleFlagCohort || isGradeSubgroup ? '#1b6070' : '#991B1B', lineHeight: 1.5 }}>
            <strong>{isGradeSubgroup ? 'Grade note: ' : isTripleFlagCohort ? 'Cohort note: ' : 'Equity flag: '}</strong>
            {activeCategory.equity_note}
          </div>
        </div>
      )}

      <div style={{ padding: '12px 14px' }}>
        {groups.map((group, i) => (
          <GroupAccordion
            key={i}
            group={group}
            isOpen={!!openGroups[i]}
            onToggle={() => toggleGroup(i)}
            metrics={metrics}
            isGradeSubgroup={isGradeSubgroup}
            isTripleFlagCohort={isTripleFlagCohort}
            isSchoolWide={isSchoolWide}
          />
        ))}
      </div>
    </div>
  )
}
