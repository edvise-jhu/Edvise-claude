import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
} from 'chart.js'

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement)

export function chartRefToPngDataUrl(chartRef) {
  const ch = chartRef?.current
  if (!ch) return null
  if (typeof ch.toBase64Image === 'function') return ch.toBase64Image()
  return null
}

export function downloadChartPng(chartRef, filename = 'edvise-chart.png') {
  const url = chartRefToPngDataUrl(chartRef)
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}
