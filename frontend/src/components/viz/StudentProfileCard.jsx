/**
 * StudentProfileCard.jsx
 *
 * Renders a structured student profile from row_level analysis data.
 * Sections are built dynamically from whatever columns exist in the mapping —
 * no hardcoded column names except for the computed flags EdVise adds itself.
 *
 * Expected data shape (from run_row_level_analysis):
 * {
 *   student_id:     string,
 *   record:         { [col]: value, ... },   // raw + computed columns
 *   col_descriptions: { [col]: label },       // human-readable labels
 *   factor_labels:  { [col]: label },         // SEL factor labels
 *   mapping: {
 *     student_id, grade, race_indicators[], sel_factors[],
 *     behavior, days_absent, attendance, math, english, failtot, ...
 *   }
 * }
 */

const NAVY = '#2A3B7C'
const AMBER = '#EFB340'
const RED = '#DC2626'
const GREEN = '#059669'

const FLAG_COLORS = {
  0: { bg: '#F0FDF4', color: '#059669', border: '#A7F3D0', label: 'No flags' },
  1: { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', label: '1 of 3 flags' },
  2: { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A', label: '2 of 3 flags' },
  3: { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA', label: '3 of 3 flags' },
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: '5px 16px',
      fontSize: 10,
      fontWeight: 600,
      color: '#7a89b8',
      textTransform: 'uppercase',
      letterSpacing: '0.07em',
      background: '#f7f9fc',
      borderBottom: '0.5px solid #e4e9f2',
    }}>
      {children}
    </div>
  )
}

function IndicatorRow({ label, active, value, icon }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 16px',
      borderBottom: '0.5px solid #f0f3fa',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, fontSize: 13,
        background: active ? '#FEF2F2' : '#F0FDF4',
        color: active ? RED : GREEN,
      }}>
        {icon}
      </div>
      <div style={{ flex: 1, fontSize: 13, color: NAVY }}>{label}</div>
      <div style={{
        fontSize: 12, fontWeight: 500,
        color: active ? RED : '#7a89b8',
      }}>
        {value}
      </div>
    </div>
  )
}

function KVRow({ label, value, last = false }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '7px 16px',
      borderBottom: last ? 'none' : '0.5px solid #f0f3fa',
      fontSize: 13,
    }}>
      <span style={{ color: '#7a89b8' }}>{label}</span>
      <span style={{ fontWeight: 500, color: NAVY }}>{value}</span>
    </div>
  )
}

function SELRow({ label, score, last = false }) {
  const num = Number(score)
  const width = isNaN(num) ? 0 : Math.min(100, (num / 5) * 100)
  const color = num >= 3.8 ? GREEN : num >= 3.0 ? AMBER : RED
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '7px 16px',
      borderBottom: last ? 'none' : '0.5px solid #f0f3fa',
    }}>
      <div style={{
        width: 130, fontSize: 12, color: '#7a89b8',
        textAlign: 'right', flexShrink: 0,
      }}>
        {label}
      </div>
      <div style={{
        flex: 1, height: 7, background: '#eef2f8',
        borderRadius: 4, overflow: 'hidden',
      }}>
        <div style={{
          width: `${width}%`, height: '100%',
          borderRadius: 4, background: color,
          transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={{
        fontSize: 12, fontWeight: 500, color: NAVY,
        width: 28, textAlign: 'right', flexShrink: 0,
      }}>
        {isNaN(num) ? '—' : num.toFixed(1)}
      </div>
    </div>
  )
}

export default function StudentProfileCard({ data }) {
  if (!data?.record || !data?.student_id) return null

  const {
    student_id,
    record,
    col_descriptions = {},
    factor_labels = {},
    mapping = {},
  } = data

  function label(col) {
    return col_descriptions[col] || col.replace(/_/g, ' ')
  }

  function boolDisplay(val) {
    if (val === true || val === 'true' || val === 1 || val === '1') return 'Yes'
    if (val === false || val === 'false' || val === 0 || val === '0') return 'No'
    return val == null || val === '' ? '—' : String(val)
  }

  const gradeCol = mapping.grade
  const gradeVal = gradeCol ? record[gradeCol] : null
  const gradeText = gradeVal != null && gradeVal !== '' ? `Grade ${gradeVal}` : null

  const flagCount = Number(record.flag_count ?? 0)
  const flagStyle = FLAG_COLORS[Math.min(flagCount, 3)] || FLAG_COLORS[0]

  const raceIndicators = mapping.race_indicators || []
  const activeRaces = raceIndicators
    .filter(col => Number(record[col]) === 1)
    .map(col => col_descriptions[col] || factor_labels[col] || col.replace(/_/g, ' '))

  const SKIP_ROLES = new Set([
    'student_id', 'grade', 'attendance', 'days_absent', 'behavior',
    'math', 'english', 'failtot', 'sel_factors', 'race_indicators', 'text_columns',
  ])
  const demoEntries = []
  for (const [role, col] of Object.entries(mapping)) {
    if (SKIP_ROLES.has(role) || role.startsWith('_') || typeof col !== 'string') continue
    if (!(col in record)) continue
    const val = record[col]
    if (val == null || val === '') continue
    demoEntries.push({ label: label(col), value: boolDisplay(val) })
  }

  const selCols = mapping.sel_factors || []
  const selScores = selCols
    .filter(col => col in record && record[col] !== '' && record[col] != null)
    .map(col => ({
      col,
      label: factor_labels[col] || col_descriptions[col] || col.replace(/_/g, ' '),
      score: Number(record[col]),
    }))
    .sort((a, b) => b.score - a.score)

  const daysCol = mapping.days_absent || mapping.attendance
  const daysMissed = record.days_missed_pct != null
    ? `${Number(record.days_missed_pct).toFixed(1)}% missed`
    : daysCol && record[daysCol] != null
      ? `${record[daysCol]} days`
      : null

  const behaviorCol = mapping.behavior
  const suspCount = behaviorCol ? record[behaviorCol] : null
  const hasSuspension = record.has_suspension === true || record.has_suspension === 'true'

  const failtotCol = mapping.failtot
  const failCount = failtotCol ? record[failtotCol] : null
  const hasAcadFail = record.has_academic_failure === true || record.has_academic_failure === 'true'

  const initials = String(student_id).slice(-2).toUpperCase()

  const subtitleParts = [
    gradeText,
    activeRaces.length ? activeRaces.join(' / ') : null,
  ].filter(Boolean)

  return (
    <div style={{
      border: '1px solid #e4e9f2',
      borderRadius: 12,
      overflow: 'hidden',
      background: '#fff',
      marginTop: 10,
      maxWidth: 560,
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '0.5px solid #e4e9f2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: '#e0f2fe',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 500, color: '#0369a1', flexShrink: 0,
          }}>
            {initials}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>
              Student {student_id}
            </div>
            {subtitleParts.length > 0 && (
              <div style={{ fontSize: 12, color: '#7a89b8', marginTop: 1 }}>
                {subtitleParts.join(' · ')}
              </div>
            )}
          </div>
        </div>
        <div style={{
          fontSize: 11, fontWeight: 500,
          padding: '3px 10px', borderRadius: 20,
          background: flagStyle.bg,
          color: flagStyle.color,
          border: `0.5px solid ${flagStyle.border}`,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}>
          {flagStyle.label}
        </div>
      </div>

      <div style={{ borderBottom: '0.5px solid #e4e9f2' }}>
        <SectionLabel>Risk indicators</SectionLabel>
        <IndicatorRow
          label="Academic failure"
          active={hasAcadFail}
          value={
            failCount != null
              ? `${failCount} course${Number(failCount) !== 1 ? 's' : ''} failed`
              : hasAcadFail ? 'Yes' : 'No'
          }
          icon={hasAcadFail ? '✕' : '✓'}
        />
        <IndicatorRow
          label="Chronic absence"
          active={record.chronic_absent === true || record.chronic_absent === 'true'}
          value={daysMissed || (record.chronic_absent ? 'Yes' : 'No')}
          icon={(record.chronic_absent === true || record.chronic_absent === 'true') ? '✕' : '✓'}
        />
        <div style={{ borderBottom: 'none' }}>
          <IndicatorRow
            label="Suspensions"
            active={hasSuspension}
            value={
              suspCount != null
                ? `${suspCount} suspension${Number(suspCount) !== 1 ? 's' : ''}`
                : hasSuspension ? 'Yes' : 'No'
            }
            icon={hasSuspension ? '✕' : '✓'}
          />
        </div>
      </div>

      {demoEntries.length > 0 && (
        <div style={{ borderBottom: '0.5px solid #e4e9f2' }}>
          <SectionLabel>Demographics</SectionLabel>
          {demoEntries.map((e, i) => (
            <KVRow
              key={e.label}
              label={e.label}
              value={e.value}
              last={i === demoEntries.length - 1}
            />
          ))}
        </div>
      )}

      {selScores.length > 0 && (
        <div style={{ borderBottom: '0.5px solid #e4e9f2' }}>
          <SectionLabel>SEL / well-being (1–5 scale)</SectionLabel>
          {selScores.map((s, i) => (
            <SELRow
              key={s.col}
              label={s.label}
              score={s.score}
              last={i === selScores.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}
