import { useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'
import UnifiedAnalysisCard from './viz/UnifiedAnalysisCard'
import SubgroupCard from './viz/SubgroupCard'
import GradeComparisonCard from './viz/GradeComparisonCard'
import FlagOverlapCard from './viz/FlagOverlapCard'
import InsightCard from './viz/InsightCard'
import StudentTableCard from './viz/StudentTableCard'
import StudentProfileCard from './viz/StudentProfileCard'

Chart.register(...registerables)

const STRUCTURED_COMPONENTS = {
  unified_analysis: UnifiedAnalysisCard,
  subgroup_breakdown: SubgroupCard,
  grade_comparison: GradeComparisonCard,
  flag_overlap: FlagOverlapCard,
  text_insight: InsightCard,
  student_table: StudentTableCard,
  student_profile: StudentProfileCard,
}

const CHART_JS_TYPES = new Set([
  'bar', 'horizontalbar', 'line', 'radar',
  'doughnut', 'pie', 'scatter', 'bubble',
])

function GenericChart({ data }) {
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  useEffect(() => {
    if (!canvasRef.current) return

    // Destroy previous instance
    if (chartRef.current) {
      chartRef.current.destroy()
      chartRef.current = null
    }

    const type = data.type === 'horizontalbar' ? 'bar' : data.type
    const isHorizontal = data.type === 'horizontalbar'
    const isRadar = type === 'radar'

    let chartData = data.data
    if (isRadar && chartData?.datasets?.length > 0 && chartData?.labels?.length > 0) {
      const numLabels = chartData.labels.length
      const numDatasets = chartData.datasets.length
      // If there are more datasets than labels, orientation is flipped — transpose it
      if (numDatasets > numLabels) {
        const newLabels = chartData.datasets.map(ds => ds.label)
        const newDatasets = chartData.labels.map((label, i) => ({
          label,
          data: chartData.datasets.map(ds => Number(ds.data[i]) || 0),
        }))
        chartData = { labels: newLabels, datasets: newDatasets }
      }
    }

    try {
      chartRef.current = new Chart(canvasRef.current, {
        type,
        data: chartData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: isHorizontal ? 'y' : 'x',
          plugins: {
            legend: {
              display: (chartData?.datasets?.length ?? 0) > 1,
              labels: { font: { family: 'Inter', size: 11 }, color: '#2A3B7C' },
            },
            title: {
              display: Boolean(data.title),
              text: data.title || '',
              font: { family: 'Inter', size: 13, weight: '600' },
              color: '#2A3B7C',
              padding: { bottom: 12 },
            },
          },
          scales: isRadar
            ? (() => {
                const allValues = (chartData?.datasets || [])
                  .flatMap(ds => (ds.data || []).map(Number).filter(n => !isNaN(n)))
                const dataMin = allValues.length ? Math.min(...allValues) : 0
                const dataMax = allValues.length ? Math.max(...allValues) : 1
                const pad = (dataMax - dataMin) * 0.1 || 0.5
                const rMin = Math.max(0, Math.floor(dataMin - pad))
                const rMax = Math.ceil(dataMax + pad)
                const range = rMax - rMin
                const stepSize = range <= 1 ? 0.2 : range <= 5 ? 0.5 : range <= 10 ? 1 : Math.ceil(range / 10)
                return {
                  r: {
                    min: rMin,
                    max: rMax,
                    ticks: {
                      stepSize,
                      font: { family: 'Inter', size: 10 },
                      color: '#7a89b8',
                    },
                    grid: { color: '#e4e9f2' },
                    pointLabels: {
                      font: { family: 'Inter', size: 11 },
                      color: '#2A3B7C',
                    },
                  },
                }
              })()
            : type === 'doughnut' || type === 'pie'
              ? {}
              : {
            x: {
              ticks: { font: { family: 'Inter', size: 11 }, color: '#7a89b8' },
              grid: { color: '#e4e9f2' },
            },
            y: {
              ticks: { font: { family: 'Inter', size: 11 }, color: '#7a89b8' },
              grid: { color: '#e4e9f2' },
              beginAtZero: true,
            },
          },
          // Merge any options Claude provided
          ...(data.options || {}),
        },
      })
    } catch (e) {
      console.warn('[GenericChart] Chart.js render failed:', e)
    }

    return () => {
      chartRef.current?.destroy()
      chartRef.current = null
    }
  }, [data])

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 10,
      overflow: 'hidden',
      background: 'var(--surface)',
      marginTop: 10,
    }}>
      {data.title && (
        <div style={{
          padding: '8px 14px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}>
          {data.title}
        </div>
      )}
      <div style={{ padding: 16, height: 280 }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

export default function VizRouter({ data, onAction }) {
  if (!data?.type) return null
  const typeKey = String(data.type).trim().toLowerCase()

  // Structured React card
  const Component = STRUCTURED_COMPONENTS[typeKey]
  if (Component) {
    return <Component data={{ ...data, type: typeKey }} onAction={onAction} />
  }

  // Generic Chart.js renderer for bar, line, radar, doughnut etc.
  if (CHART_JS_TYPES.has(typeKey)) {
    return <GenericChart data={{ ...data, type: typeKey }} />
  }

  return null
}