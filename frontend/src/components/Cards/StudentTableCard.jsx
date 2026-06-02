import { useMemo, useState, useCallback, useEffect } from 'react'

function findIdKey(row, mapping) {
  if (!row) return null
  const keys = Object.keys(row)
  const preferred = ['student_id', 'StudentID', 'studentid', 'SID', 'id', 'Id', 'ID']
  for (const k of preferred) {
    if (keys.includes(k)) return k
  }
  for (const k of keys) {
    if (/student|sid/i.test(k) && !/grade|math|eng|att|behav|miss|tier|flag|chronic|severe|suspension|failure|days/i.test(k)) {
      return k
    }
  }
  return keys[0] || null
}

function YnBadge({ value, yesMeans }) {
  const isYes = yesMeans ? Boolean(value) : !value
  return (
    <span
      className="yn-badge"
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 600,
        background: isYes ? '#e8f5e9' : '#eef0f5',
        color: isYes ? '#2e7d32' : 'var(--text-muted)',
      }}
    >
      {isYes ? 'Yes' : 'No'}
    </span>
  )
}

function escapeCsvCell(v) {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Mapping roles rendered on rosters when columns exist in uploaded data. */
const ROSTER_DEMO_FIELDS = [
  { role: 'ell', label: 'ELL', mappingKeys: ['ell', 'lep'] },
  { role: 'low_ses', label: 'Low SES', mappingKeys: ['low_ses'] },
  { role: 'special_ed', label: 'Special Ed', mappingKeys: ['special_ed'] },
]

function isDemographicYes(value) {
  if (value === true || value === 1 || value === '1') return true
  const s = String(value ?? '').trim().toLowerCase()
  return ['yes', 'y', 'true', 'ell', 'sped', 'iep'].includes(s)
}

function resolveRosterDemographicColumns(mapping, sampleRow) {
  if (!mapping || !sampleRow) return []
  const out = []
  const seen = new Set()
  for (const def of ROSTER_DEMO_FIELDS) {
    const col = def.mappingKeys.map((k) => mapping[k]).find((c) => c && Object.prototype.hasOwnProperty.call(sampleRow, c))
    if (!col || seen.has(col)) continue
    seen.add(col)
    out.push({ ...def, col })
  }
  return out
}

function demoPriorityScore(row, demoColumns, priorityRoles) {
  if (!priorityRoles?.length) return 0
  let score = 0
  for (const def of demoColumns) {
    if (!priorityRoles.includes(def.role)) continue
    if (isDemographicYes(row[def.col])) score += 1
  }
  return score
}

function SortTh({ label, sortKey, current, onSort }) {
  const active = current?.key === sortKey
  const mark = active ? (current.dir === 'asc' ? ' ▲' : ' ▼') : ''
  return (
    <th
      className="student-table-th-sortable"
      onClick={() => onSort(sortKey)}
      title="Click to sort"
      role="columnheader"
    >
      {label}
      <span className="student-table-sort-mark">{mark || ' ↕'}</span>
    </th>
  )
}

export default function StudentTableCard({ data }) {
  const {
    students = [],
    risk,
    mapping = {},
    studentsMeta = {},
    onTierChange,
    initialGrade = null,
    initialSort = null,
  } = data || {}
  const tierFilter = studentsMeta.tier_filter || 'critical'
  const [search, setSearch] = useState('')
  const [gradeFilter, setGradeFilter] = useState(initialGrade || 'all')
  const priorityRoles = studentsMeta.filters_applied?.demographic_sort_roles || []
  const initialSubFilter =
    priorityRoles.length > 0 ? 'priority_demographics' : 'all'
  const [subFilter, setSubFilter] = useState(initialSubFilter)
  const [minDaysMissed, setMinDaysMissed] = useState('')
  const [onlyBelow90Present, setOnlyBelow90Present] = useState(false)
  const [sort, setSort] = useState(initialSort)

  useEffect(() => {
    setGradeFilter(initialGrade || 'all')
  }, [initialGrade])

  useEffect(() => {
    if (initialSort) setSort(initialSort)
  }, [initialSort?.key, initialSort?.dir])

  useEffect(() => {
    if (priorityRoles.length > 0) setSubFilter('priority_demographics')
  }, [studentsMeta.filters_applied?.demographic_sort_roles?.join(',')])

  const idKey = useMemo(() => findIdKey(students[0], mapping), [students, mapping])
  const gradeCol = mapping.grade
  const mathCol = mapping.math
  const engCol = mapping.english
  const attCol = mapping.attendance
  const failtotCol = mapping.failtot
  const demoColumns = useMemo(
    () => resolveRosterDemographicColumns(mapping, students[0]),
    [mapping, students],
  )

  const gradesInData = useMemo(() => {
    if (!gradeCol) return []
    const s = new Set()
    students.forEach((row) => {
      const g = row[gradeCol]
      if (g !== undefined && g !== null && g !== '') s.add(String(g))
    })
    return [...s].sort()
  }, [students, gradeCol])

  const filtered = useMemo(() => {
    let rows = students.slice()
    const q = search.trim().toLowerCase()
    if (q && idKey) {
      rows = rows.filter((r) => String(r[idKey] ?? '').toLowerCase().includes(q))
    }
    if (gradeFilter !== 'all' && gradeCol) {
      rows = rows.filter((r) => String(r[gradeCol]) === gradeFilter)
    }
    // Sub-filters
    if (subFilter === 'chronic') {
      rows = rows.filter((r) => r.chronic_absent === true || Number(r.days_missed_pct) >= 10)
    } else if (subFilter === 'severe') {
      rows = rows.filter((r) => r.severe_absent === true || Number(r.days_missed_pct) >= 20)
    } else if (subFilter === 'all3') {
      rows = rows.filter((r) => Number(r.flag_count) === 3)
    } else if (subFilter === 'suspended') {
      rows = rows.filter((r) => r.has_suspension === true)
    } else if (subFilter === 'academic') {
      rows = rows.filter((r) => r.has_academic_failure === true)
    } else if (subFilter === 'chronic_academic') {
      rows = rows.filter((r) =>
        (r.chronic_absent === true || Number(r.days_missed_pct) >= 10) &&
        r.has_academic_failure === true
      )
    } else if (subFilter.startsWith('only_demo_')) {
      const role = subFilter.replace('only_demo_', '')
      const def = demoColumns.find((d) => d.role === role)
      if (def) rows = rows.filter((r) => isDemographicYes(r[def.col]))
    }
    const minDm = parseFloat(String(minDaysMissed), 10)
    if (!Number.isNaN(minDm) && minDaysMissed !== '') {
      rows = rows.filter((r) => Number(r.days_missed_pct) >= minDm)
    }
    if (onlyBelow90Present && attCol) {
      rows = rows.filter((r) => {
        const v = Number(r[attCol])
        return !Number.isNaN(v) && v < 0.9
      })
    }
    return rows
  }, [
    students, search, idKey, gradeFilter, gradeCol,
    subFilter, minDaysMissed, onlyBelow90Present, attCol, demoColumns,
  ])

  const sorted = useMemo(() => {
    const rows = filtered.slice()
    const rolesForPriority =
      subFilter === 'priority_demographics' && priorityRoles.length
        ? priorityRoles
        : subFilter === 'priority_demographics' && demoColumns.length
          ? demoColumns.map((d) => d.role)
          : []
    if (!sort && rolesForPriority.length) {
      rows.sort((a, b) => {
        const pa = demoPriorityScore(a, demoColumns, rolesForPriority)
        const pb = demoPriorityScore(b, demoColumns, rolesForPriority)
        if (pb !== pa) return pb - pa
        return (Number(b.days_missed_pct) || 0) - (Number(a.days_missed_pct) || 0)
      })
      return rows
    }
    if (!sort) return rows
    const { key, dir } = sort
    const mul = dir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      switch (key) {
        case 'id': {
          const va = String(a[idKey] ?? '')
          const vb = String(b[idKey] ?? '')
          return mul * va.localeCompare(vb, undefined, { numeric: true })
        }
        case 'grade': {
          const na = Number(a[gradeCol]) || -Infinity
          const nb = Number(b[gradeCol]) || -Infinity
          return mul * (na - nb)
        }
        case 'att': {
          const na = attCol ? (Number(a[attCol]) || -Infinity) : -Infinity
          const nb = attCol ? (Number(b[attCol]) || -Infinity) : -Infinity
          return mul * (na - nb)
        }
        case 'dmp': {
          const na = Number(a.days_missed_pct) || 0
          const nb = Number(b.days_missed_pct) || 0
          return mul * (na - nb)
        }
        case 'susp':
          return mul * (Number(Boolean(a.has_suspension)) - Number(Boolean(b.has_suspension)))
        case 'fail':
          return mul * (Number(Boolean(a.has_academic_failure)) - Number(Boolean(b.has_academic_failure)))
        case 'failtot': {
          const na = failtotCol ? (Number(a[failtotCol]) || 0) : 0
          const nb = failtotCol ? (Number(b[failtotCol]) || 0) : 0
          return mul * (na - nb)
        }
        default:
          return 0
      }
    })
    return rows
  }, [filtered, sort, idKey, gradeCol, attCol, failtotCol, subFilter, priorityRoles, demoColumns])

  const toggleSort = useCallback((sortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== sortKey) return { key: sortKey, dir: 'desc' }
      if (prev.dir === 'desc') return { key: sortKey, dir: 'asc' }
      return null
    })
  }, [])

  const totalInDataset = risk?.total ?? students.length
  const severeCount =
    studentsMeta.severe_absent_count ??
    risk?.flags?.severe_absence ??
    students.filter((r) => r.severe_absent === true || Number(r.days_missed_pct) >= 20).length

  const matchTotal = studentsMeta.total ?? students.length
  const loadedCount = students.length
  const displayCount =
    gradeFilter !== 'all' && gradeCol && studentsMeta.by_grade?.[gradeFilter] != null
      ? studentsMeta.by_grade[gradeFilter]
      : matchTotal
  const chronicCount =
    studentsMeta.chronic_absent_count ??
    risk?.flags?.chronic_absence ??
    students.filter((r) => r.chronic_absent === true || Number(r.days_missed_pct) >= 10).length

  const gradeSummary = studentsMeta.by_grade
    ? Object.entries(studentsMeta.by_grade).map(([g, n]) => `G${g}: ${n}`).join(' · ')
    : risk?.grade_breakdown
      ? Object.entries(risk.grade_breakdown).map(([g, v]) => `G${g}: ${v.total ?? 0}`).join(' · ')
      : null

  function cellFail(row, col) {
    if (!col || row[col] === undefined || row[col] === null) return false
    return Number(row[col]) === 1
  }

  function formatPresentRate(row) {
    if (!attCol || row[attCol] === undefined || row[attCol] === null) return '—'
    const v = Number(row[attCol])
    if (Number.isNaN(v)) return String(row[attCol])
    return `${(v * 100).toFixed(0)}%`
  }

  function downloadCsv() {
    const headers = [
      idKey || 'id',
      gradeCol || 'grade',
      attCol ? 'present_rate' : null,
      'days_missed_pct',
      'chronic_absent',
      'severe_absent',
      'has_suspension',
      'has_academic_failure',
      failtotCol || null,
      engCol || null,
      mathCol || null,
      ...demoColumns.map((d) => d.col),
    ].filter(Boolean)
    const lines = [
      headers.join(','),
      ...sorted.map((row) =>
        headers.map((h) => {
          if (h === 'present_rate' && attCol) return escapeCsvCell(row[attCol])
          return escapeCsvCell(row[h])
        }).join(','),
      ),
    ]
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `edvise-students-${tierFilter}-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const listTitle = studentsMeta.list_title
  const cardTitle =
    listTitle ||
    (tierFilter === 'triple'
      ? 'Students matching your question'
      : tierFilter === 'two_or_more'
        ? 'Students with 2+ risk flags (overlap)'
        : tierFilter === 'academic_only'
          ? 'Academic-only outreach list'
          : tierFilter === 'absent_academic'
            ? 'Chronic absence + academic failure'
            : 'Highest-risk students')
  const cardSub =
    studentsMeta.sort_by === 'courses_failed' || studentsMeta.filters_applied?.min_course_failures
      ? 'Sorted by total courses failed · export CSV'
      : tierFilter === 'triple'
        ? 'Sortable table · use filters below · export CSV — data from your upload'
        : 'Sortable table · filters · CSV export'

  const showFilteredCount =
    tierFilter !== 'all' ||
    studentsMeta.filters_applied?.min_course_failures != null ||
    studentsMeta.filters_applied?.min_suspension_count != null ||
    studentsMeta.filters_applied?.require_ell ||
    studentsMeta.filters_applied?.demographic_subset

  return (
    <div className="analysis-card student-table-card">
      <div className="analysis-card-header">
        <div className="analysis-card-header-text">
          <span className="analysis-card-title">{cardTitle}</span>
          <span className="analysis-card-sub">{cardSub}</span>
        </div>
      </div>
      <div className="analysis-card-body">
        <div className="student-table-summary">
          <div className="sts-row">
            <span>
              <strong>{showFilteredCount ? 'Matching this filter:' : 'Total in dataset:'}</strong>{' '}
              {showFilteredCount && displayCount != null ? displayCount : totalInDataset}
            </span>
            {gradeSummary && (
              <span><strong>By grade:</strong> {gradeSummary}</span>
            )}
            <span><strong>Chronically absent (10%+):</strong> {chronicCount}</span>
            <span><strong>Severely absent (20%+):</strong> {severeCount}</span>
          </div>
        </div>

        <div className="student-table-filters">
          {/* Risk tier selector */}
          <select
            className="student-table-select"
            value={tierFilter}
            onChange={(e) => onTierChange?.(e.target.value)}
            aria-label="Risk tier list filter"
          >
            <option value="triple">All 3 indicators</option>
            <option value="academic_only">Academic only</option>
            <option value="absent_academic">Absent + academic</option>
            <option value="critical">Critical</option>
            <option value="high">High (2 flags)</option>
            <option value="two_or_more">2+ flags (overlap)</option>
            <option value="moderate">Moderate</option>
            <option value="on_track">On Track</option>
            <option value="all">All students</option>
          </select>

          {/* Student ID search */}
          <input
            type="search"
            className="student-table-search"
            placeholder="Search by student ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter by student ID"
          />

          {/* Grade filter */}
          <select
            className="student-table-select"
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value)}
            aria-label="Filter by grade"
          >
            <option value="all">All grades</option>
            {gradesInData.map((g) => (
              <option key={g} value={g}>Grade {g}</option>
            ))}
          </select>

          {/* Sub-filter — all meaningful combinations */}
          <select
            className="student-table-select"
            value={subFilter}
            onChange={(e) => setSubFilter(e.target.value)}
            aria-label="Risk sub-filter"
          >
            <option value="all">All rows in list</option>
            <option value="chronic">Chronically absent (10%+)</option>
            <option value="severe">Severely absent (20%+)</option>
            <option value="chronic_academic">Chronic absence + academic failure</option>
            <option value="suspended">Has suspension</option>
            <option value="academic">Has academic failure</option>
            <option value="all3">All 3 flags</option>
            {demoColumns.length > 0 && (
              <option value="priority_demographics">
                Priority:{' '}
                {(priorityRoles.length
                  ? priorityRoles
                  : demoColumns.map((d) => d.role)
                )
                  .map((r) => demoColumns.find((d) => d.role === r)?.label || r)
                  .join(' or ')}
              </option>
            )}
            {demoColumns.map((d) => (
              <option key={`only-${d.role}`} value={`only_demo_${d.role}`}>
                Only {d.label}
              </option>
            ))}
          </select>

          {/* Min days missed */}
          <label className="student-table-filter-label">
            Min days missed %
            <input
              type="number"
              className="student-table-num"
              min={0}
              max={100}
              step={1}
              placeholder="e.g. 25"
              value={minDaysMissed}
              onChange={(e) => setMinDaysMissed(e.target.value)}
              aria-label="Minimum days missed percent"
            />
          </label>

          {attCol && (
            <label className="student-table-filter-check">
              <input
                type="checkbox"
                checked={onlyBelow90Present}
                onChange={(e) => setOnlyBelow90Present(e.target.checked)}
              />
              Present &lt; 90%
            </label>
          )}

          <button type="button" className="student-table-export" onClick={downloadCsv}>
            Export CSV
          </button>
        </div>

        <div className="student-table-scroll">
          <table className="student-table">
            <thead>
              <tr>
                <SortTh label="Student ID" sortKey="id" current={sort} onSort={toggleSort} />
                <SortTh label="Grade" sortKey="grade" current={sort} onSort={toggleSort} />
                {attCol && (
                  <SortTh label="Present (att.)" sortKey="att" current={sort} onSort={toggleSort} />
                )}
                <SortTh label="Days missed %" sortKey="dmp" current={sort} onSort={toggleSort} />
                <th>Chronic abs.</th>
                <th>Severe abs.</th>
                <SortTh label="Susp." sortKey="susp" current={sort} onSort={toggleSort} />
                <SortTh label="Fail any" sortKey="fail" current={sort} onSort={toggleSort} />
                {failtotCol && (
                  <SortTh label="Courses failed" sortKey="failtot" current={sort} onSort={toggleSort} />
                )}
                <th>Eng fail</th>
                <th>Math fail</th>
                {demoColumns.map((d) => (
                  <th key={d.col}>{d.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={10 + demoColumns.length} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
                    No students match the current filters
                  </td>
                </tr>
              ) : (
                sorted.map((row, i) => {
                  const sid = idKey ? row[idKey] : `—${i}`
                  const gr = gradeCol ? row[gradeCol] : '—'
                  const dmp = row.days_missed_pct
                  const dmpNum = Number(dmp)
                  const severeStyle = row.severe_absent === true || dmpNum >= 20
                  return (
                    <tr key={`${sid}-${i}`}>
                      <td>{String(sid)}</td>
                      <td>{gr !== undefined && gr !== null ? String(gr) : '—'}</td>
                      {attCol && <td>{formatPresentRate(row)}</td>}
                      <td style={{ fontWeight: 600, color: severeStyle ? 'var(--risk-critical)' : 'var(--text)' }}>
                        {dmp !== undefined && dmp !== null ? `${Number(dmp).toFixed(1)}%` : '—'}
                      </td>
                      <td><YnBadge value={row.chronic_absent} yesMeans /></td>
                      <td><YnBadge value={row.severe_absent} yesMeans /></td>
                      <td><YnBadge value={row.has_suspension} yesMeans /></td>
                      <td><YnBadge value={row.has_academic_failure} yesMeans /></td>
                      {failtotCol && (
                        <td style={{ fontWeight: 700, color: 'var(--risk-critical)' }}>
                          {row[failtotCol] !== undefined && row[failtotCol] !== null
                            ? Number(row[failtotCol])
                            : '—'}
                        </td>
                      )}
                      <td><YnBadge value={cellFail(row, engCol)} yesMeans /></td>
                      <td><YnBadge value={cellFail(row, mathCol)} yesMeans /></td>
                      {demoColumns.map((d) => (
                        <td key={d.col}>
                          <YnBadge value={isDemographicYes(row[d.col])} yesMeans />
                        </td>
                      ))}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="student-table-footer">
          Showing {sorted.length} of {matchTotal} matching
          {studentsMeta.truncated && loadedCount < matchTotal && (
            <span className="student-table-scroll-hint">
              {' '}
              · first {loadedCount} loaded in the table; narrow by grade or use Export CSV for the full set
            </span>
          )}
          {!studentsMeta.truncated && sorted.length < loadedCount && (
            <span className="student-table-scroll-hint"> · adjust filters to see more</span>
          )}
        </div>
      </div>
    </div>
  )
}