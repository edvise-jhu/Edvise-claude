import { useState } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  BarElement,
  ArcElement,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Bar, Doughnut, Line, Radar, Scatter } from 'react-chartjs-2'

ChartJS.register(
  CategoryScale,
  LinearScale,
  RadialLinearScale,
  BarElement,
  ArcElement,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
)

const log = (...args) => {
  if (import.meta.env.DEV) console.debug('[ArtifactRenderer]', ...args)
}

function cleanMarkdownText(value) {
  const text = String(value ?? '')
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

function SELChartArtifact({ artifact }) {
  const [activeTab, setActiveTab] = useState(0)
  const groups = artifact.groups || []

  console.log('SELChartArtifact data:', JSON.stringify(artifact, null, 2))

  const active = groups[activeTab]

  if (!active) {
    log('sel_chart: no groups', artifact)
    return null
  }

  log('sel_chart: rendering', groups.length, 'tabs')

  const chartData = {
    labels: active.labels,
    datasets: [
      {
        label: 'Class Average',
        data: active.average_data,
        backgroundColor: '#d0d5e8',
        borderRadius: 3,
      },
      {
        label: active.label,
        data: active.group_data,
        backgroundColor: active.color,
        borderRadius: 3,
      },
    ],
  }

  const options = {
    indexAxis: 'y',
    plugins: {
      legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } },
    },
    scales: {
      x: { min: 0, max: 5, grid: { color: '#f0f0f0' }, ticks: { font: { size: 10 } } },
      y: { grid: { display: false }, ticks: { font: { size: 11 } } },
    },
    maintainAspectRatio: false,
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {groups.map((g, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActiveTab(i)}
            style={{
              padding: '5px 12px',
              borderRadius: 20,
              border: `1px solid ${activeTab === i ? g.color : '#e4e9f2'}`,
              background: activeTab === i ? `${g.color}22` : 'white',
              color: activeTab === i ? '#2A3B7C' : '#7a89b8',
              fontSize: 12,
              fontWeight: activeTab === i ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            {g.label} (n={g.n})
          </button>
        ))}
      </div>

      <div style={{ height: 280 }}>
        <Bar data={chartData} options={options} />
      </div>
    </div>
  )
}

/**
 * Renders Claude-emitted chart/table artifacts (JSON inside <artifact> tags).
 * @param {object} artifact — parsed JSON; may include artifactType from the outer tag ('chart' | 'table' | 'sel_chart')
 */
export default function ArtifactRenderer({ artifact }) {
  if (!artifact) return null

  const outerType = artifact.artifactType || artifact.type

  if (outerType === 'sel_chart' || (Array.isArray(artifact.groups) && artifact.groups.length > 0)) {
    return <SELChartArtifact artifact={artifact} />
  }

  if (artifact.headers && Array.isArray(artifact.rows)) {
    return (
      <div style={{ overflowX: 'auto' }}>
        {artifact.summary && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            {artifact.summary}
          </div>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {artifact.headers.map((h, i) => (
                <th
                  key={i}
                  style={{
                    padding: '6px 10px',
                    background: 'var(--bg)',
                    borderBottom: '1px solid var(--border)',
                    textAlign: 'left',
                    fontWeight: 600,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cleanMarkdownText(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                {row.map((cell, j) => (
                  <td key={j} style={{ padding: '6px 10px', color: 'var(--text)' }}>
                    {cleanMarkdownText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const chartType = artifact.innerType || artifact.type
  const data = artifact.data
  const options = artifact.options || {}

  if (chartType === 'doughnut' && data) {
    return (
      <div style={{ height: 220, width: 220, margin: '0 auto' }}>
        <Doughnut data={data} options={options} />
      </div>
    )
  }

  if (chartType === 'radar' && data) {
    return (
      <div style={{ height: 300 }}>
        <Radar data={data} options={options} />
      </div>
    )
  }

  if (chartType === 'line' && data) {
    return (
      <div style={{ height: 240 }}>
        <Line data={data} options={options} />
      </div>
    )
  }

  if (chartType === 'scatter' && data) {
    return (
      <div style={{ height: 240 }}>
        <Scatter data={data} options={options} />
      </div>
    )
  }

  if ((chartType === 'bar' || chartType === 'horizontalBar') && data) {
    return (
      <div style={{ height: 240 }}>
        <Bar
          data={data}
          options={{
            ...options,
            indexAxis: chartType === 'horizontalBar' ? 'y' : (options.indexAxis || 'x'),
          }}
        />
      </div>
    )
  }

  if (chartType === 'table' && data) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Table-type chart: provide <code>headers</code> and <code>rows</code> in the artifact JSON, or use{' '}
        <code>&lt;artifact type=&quot;table&quot;&gt;</code> with headers/rows.
      </div>
    )
  }

  log('unhandled artifact shape', outerType, Object.keys(artifact))
  return null
}
