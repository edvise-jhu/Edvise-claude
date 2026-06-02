import { useMemo, useState } from 'react'
import {
  applyAcademicPreset,
  buildDefaultCriteria,
  criteriaToThresholds,
  detectColumnFormat,
  thresholdsToCriteria,
  unusedColumnsForCourses,
} from '../../lib/criteriaUtils'

const DOT = {
  attendance: '#3E94A5',
  academic: '#3E94A5',
  behavior: '#B45309',
  absenceBasis: '#94A3B8',
}

const CHRONIC_OPTIONS = [
  { value: 5, label: '≥5% days missed' },
  { value: 10, label: '≥10% days missed' },
  { value: 15, label: '≥15% days missed' },
  { value: 20, label: '≥20% days missed' },
]

const ACADEMIC_PRESETS = [
  { value: 'fail_f_in_1', label: 'Fail (F) in ≥1 course' },
  { value: 'fail_f_in_2', label: 'Fail (F) in ≥2 courses' },
  { value: 'fail_d_in_1', label: 'Fail (D or below) in ≥1 course' },
  { value: 'binary_any', label: 'Fail flag (0/1) in ≥1 course' },
  { value: 'failtot_min', label: 'Failed courses count ≥1' },
]

const SUSPENSION_OPTIONS = [
  { value: 1, label: '≥1 suspension' },
  { value: 2, label: '≥2 suspensions' },
  { value: 3, label: '≥3 suspensions' },
]

const FORMAT_OPTIONS = [
  { value: 'letter', label: 'Letter grade' },
  { value: 'binary', label: 'Fail flag (0/1)' },
  { value: 'numeric', label: 'Numeric grade' },
  { value: 'count', label: 'Course count' },
]

const LETTER_RULE_OPTIONS = [
  { value: 'F_only', label: 'F only' },
  { value: 'D_or_below', label: 'D or below' },
]

function CriteriaRow({ dotColor, label, children }) {
  return (
    <div className="criteria-row" style={{ borderBottom: '1px solid #eef2f8', padding: '14px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#2A3B7C', fontWeight: 500, minWidth: 0, flex: 1 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
          <span>{label}</span>
        </div>
        <div style={{ flexShrink: 0 }}>{children}</div>
      </div>
    </div>
  )
}

function Select({ value, onChange, options, style = {} }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        border: '1px solid #d4dff7',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 12,
        color: '#2A3B7C',
        background: '#fff',
        minWidth: 200,
        maxWidth: '100%',
        ...style,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

export default function CriteriaSettingCard({ data, onConfirm }) {
  const mapping = data?.mapping || {}
  const preview = data?.preview || []
  const allColumns = data?.columns || []
  const columnMetadata = data?.column_metadata || {}

  const defaults = useMemo(
    () => buildDefaultCriteria(mapping, preview, columnMetadata),
    [mapping, preview, columnMetadata],
  )

  const [criteria, setCriteria] = useState(
    data?.current_thresholds ? thresholdsToCriteria(data.current_thresholds, defaults) : defaults
  )
  const [confirmed, setConfirmed] = useState(false)

  const hasAttendance = Boolean(mapping.attendance)
  const hasDaysAbsent = Boolean(mapping.days_absent)
  const hasBehavior = Boolean(mapping.behavior)
  const hasAcademic = (criteria.courseRules || []).length > 0

  const addableColumns = unusedColumnsForCourses(mapping, criteria.courseRules, allColumns)

  function setField(key, value) {
    setCriteria((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'academicPreset') {
        const patch = applyAcademicPreset(value, prev.courseRules)
        next.academicMinCourses = patch.academicMinCourses
        next.courseRules = patch.courseRules
      }
      return next
    })
  }

  function updateCourse(id, patch) {
    setCriteria((prev) => ({
      ...prev,
      courseRules: prev.courseRules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }))
  }

  function removeCourse(id) {
    setCriteria((prev) => ({
      ...prev,
      courseRules: prev.courseRules.filter((r) => r.id !== id),
    }))
  }

  function addCourse(column) {
    if (!column) return
    const format = detectColumnFormat(column, preview)
    const label = columnMetadata?.[column]?.label || column
    setCriteria((prev) => ({
      ...prev,
      courseRules: [
        ...prev.courseRules,
        {
          id: `custom_${column}`,
          key: 'custom',
          column,
          label,
          format: format === 'count' ? 'count' : format,
          letter_rule: 'F_only',
          numeric_below: 60,
          min_count: 1,
        },
      ],
    }))
  }

  function handleRun() {
    const thresholds = criteriaToThresholds(criteria)
    setConfirmed(true)
    onConfirm({ criteria, thresholds })
  }

  if (confirmed) {
    return (
      <div style={{ border: '1px solid #e4e9f2', borderRadius: 10, padding: '10px 14px', background: '#f7f9fc', fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: '#2A3B7C', marginBottom: 4 }}>✓ Indicator criteria set</div>
        <div style={{ color: '#7a89b8', lineHeight: 1.5 }}>
          Chronic absence ≥{criteria.chronicPct}%
          {hasBehavior && ` · Suspensions ≥${criteria.suspensionMin}`}
          {hasAcademic && ` · ${criteria.courseRules.length} course column${criteria.courseRules.length === 1 ? '' : 's'} checked`}
        </div>
      </div>
    )
  }

  const absenceBasisOptions = []
  if (hasAttendance) absenceBasisOptions.push({ value: 'rate', label: '% of enrolled days' })
  if (hasDaysAbsent) absenceBasisOptions.push({ value: 'days', label: 'Raw days absent' })

  return (
    <div className="analysis-card" style={{ maxWidth: 560 }}>
      <div className="analysis-card-header">
        <span className="analysis-card-title">Set indicator criteria</span>
      </div>
      <div className="analysis-card-body" style={{ paddingTop: 4, paddingBottom: 8 }}>
        {(hasAttendance || hasDaysAbsent) && (
          <CriteriaRow dotColor={DOT.attendance} label="Chronic absence — flag students with">
            <Select
              value={criteria.chronicPct}
              onChange={(v) => setField('chronicPct', Number(v))}
              options={CHRONIC_OPTIONS}
            />
          </CriteriaRow>
        )}

        {hasAcademic && (
          <div style={{ borderBottom: '1px solid #eef2f8', padding: '14px 0' }}>
            <CriteriaRow dotColor={DOT.academic} label="Course failure — flag students who">
              <Select
                value={criteria.academicPreset}
                onChange={(v) => setField('academicPreset', v)}
                options={ACADEMIC_PRESETS}
              />
            </CriteriaRow>

            <div style={{ marginTop: 12, paddingLeft: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#2A3B7C', marginBottom: 4 }}>
                Courses included in failure check
              </div>
              <p style={{ fontSize: 11, color: '#7a89b8', margin: '0 0 10px' }}>
                Format auto-detected from your data — switch per course if needed
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {criteria.courseRules.map((course) => (
                  <div
                    key={course.id}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
                  >
                    <input
                      type="text"
                      value={course.label}
                      onChange={(e) => updateCourse(course.id, { label: e.target.value })}
                      style={{
                        width: 88,
                        border: '1px solid #d4dff7',
                        borderRadius: 8,
                        padding: '6px 8px',
                        fontSize: 12,
                      }}
                    />
                    <Select
                      value={course.format}
                      onChange={(v) => updateCourse(course.id, { format: v })}
                      options={FORMAT_OPTIONS.filter((o) => (course.key === 'failtot' ? o.value === 'count' : true))}
                      style={{ minWidth: 130 }}
                    />
                    {course.format === 'letter' && (
                      <Select
                        value={course.letter_rule}
                        onChange={(v) => updateCourse(course.id, { letter_rule: v })}
                        options={LETTER_RULE_OPTIONS}
                        style={{ minWidth: 100 }}
                      />
                    )}
                    {course.format === 'numeric' && (
                      <label style={{ fontSize: 11, color: '#7a89b8', display: 'flex', alignItems: 'center', gap: 4 }}>
                        Below
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={course.numeric_below ?? 60}
                          onChange={(e) => updateCourse(course.id, { numeric_below: Number(e.target.value) })}
                          style={{ width: 44, border: '1px solid #d4dff7', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
                        />
                      </label>
                    )}
                    {criteria.courseRules.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeCourse(course.id)}
                        aria-label="Remove course"
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: '#94a3b8',
                          cursor: 'pointer',
                          fontSize: 16,
                          lineHeight: 1,
                          padding: '4px 6px',
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {addableColumns.length > 0 && (
                <AddCourseControl columns={addableColumns} onAdd={addCourse} />
              )}
            </div>
          </div>
        )}

        {hasBehavior && (
          <CriteriaRow dotColor={DOT.behavior} label="Suspension — flag students with">
            <Select
              value={criteria.suspensionMin}
              onChange={(v) => setField('suspensionMin', Number(v))}
              options={SUSPENSION_OPTIONS}
            />
          </CriteriaRow>
        )}

        {absenceBasisOptions.length > 0 && (
          <CriteriaRow dotColor={DOT.absenceBasis} label="Absence calculation based on">
            <Select
              value={criteria.absenceBasis}
              onChange={(v) => setField('absenceBasis', v)}
              options={absenceBasisOptions}
            />
          </CriteriaRow>
        )}

        {criteria.absenceBasis === 'days' && hasDaysAbsent && (
          <div style={{ paddingBottom: 12, fontSize: 11, color: '#7a89b8' }}>
            School year length:
            <input
              type="number"
              min={1}
              max={365}
              value={criteria.totalSchoolDays}
              onChange={(e) => setField('totalSchoolDays', Number(e.target.value) || 180)}
              style={{ width: 56, marginLeft: 6, border: '1px solid #d4dff7', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
            />
            {' '}days
          </div>
        )}

        <button
          type="button"
          className="sc-btn"
          onClick={handleRun}
          style={{
            marginTop: 8,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: '#3E94A5',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Run analysis with these criteria →
        </button>
      </div>
    </div>
  )
}

function AddCourseControl({ columns, onAdd }) {
  const [col, setCol] = useState('')
  return (
    <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <select
        value={col}
        onChange={(e) => setCol(e.target.value)}
        style={{
          border: '1px dashed #3E94A5',
          borderRadius: 8,
          padding: '6px 10px',
          fontSize: 12,
          color: '#3E94A5',
          background: '#f0f8fa',
          flex: 1,
          minWidth: 140,
        }}
      >
        <option value="">+ Add another course</option>
        {columns.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={!col}
        onClick={() => { onAdd(col); setCol('') }}
        className="sc-btn"
        style={{ fontSize: 12, padding: '6px 12px' }}
      >
        Add
      </button>
    </div>
  )
}
