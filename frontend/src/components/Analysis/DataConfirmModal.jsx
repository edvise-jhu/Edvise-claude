import { useState } from 'react'

const VARIABLE_LABELS = {
  attendance: 'Attendance Rate',
  behavior: 'Suspensions / Behavior',
  math: 'Math Failure Flag',
  english: 'English Failure Flag',
  grade: 'Grade Level',
}

export default function DataConfirmModal({ uploadResult, onConfirm, onCancel }) {
  const [mapping, setMapping] = useState(uploadResult.suggested_mapping || {})

  function updateMapping(key, col) {
    setMapping(prev => ({ ...prev, [key]: col || undefined }))
  }

  const cols = uploadResult.columns || []

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-2xl shadow-xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-semibold text-brand text-lg">Confirm Variable Mapping</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {uploadResult.filename} — {uploadResult.rows} students
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            EdVise detected the following columns. Confirm or adjust the mapping before running analysis.
          </p>

          {Object.entries(VARIABLE_LABELS).map(([key, label]) => (
            <div key={key} className="flex items-center gap-3">
              <label className="w-40 text-sm font-medium text-gray-700 shrink-0">{label}</label>
              <select
                value={mapping[key] || ''}
                onChange={e => updateMapping(key, e.target.value)}
                className="flex-1 rounded-lg border border-border px-3 py-2 text-sm bg-bg focus:outline-none focus:border-primary"
              >
                <option value="">— not mapped —</option>
                {cols.map(col => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        {/* Data preview */}
        {uploadResult.preview && (
          <div className="px-6 pb-4">
            <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wide">Preview (first 3 rows)</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="text-xs w-full">
                <thead>
                  <tr className="bg-bg border-b border-border">
                    {cols.slice(0, 8).map(col => (
                      <th key={col} className="px-3 py-2 text-left text-gray-600 font-medium whitespace-nowrap">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {uploadResult.preview.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      {cols.slice(0, 8).map(col => (
                        <td key={col} className="px-3 py-2 text-gray-700 whitespace-nowrap">{String(row[col] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(mapping)}
            className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition-colors"
          >
            Confirm & Analyze
          </button>
        </div>
      </div>
    </div>
  )
}
