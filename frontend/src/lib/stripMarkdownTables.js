/**
 * stripMarkdownTables.js
 *
 * Removes markdown tables from assistant responses that should only
 * contain prose — specifically student list summaries where the
 * interactive StudentTableCard already renders the data.
 */

/**
 * Remove all markdown tables from text, replacing them with nothing.
 * Also removes any "| --- |" divider lines that appear without a full table.
 */
function stripMarkdownTables(text) {
  if (!text) return text

  const lines = text.split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // Detect start of a markdown table (line contains | and next line is a divider)
    const isTableRow = trimmed.includes('|') && trimmed.startsWith('|')
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : ''
    const nextIsDivider = /^\|[\s|:-]+\|/.test(nextLine)

    if (isTableRow && nextIsDivider) {
      // Skip entire table block
      i++ // skip header
      i++ // skip divider
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        i++ // skip data rows
      }
      continue
    }

    // Skip orphaned divider lines
    if (/^\|[\s|:-]+\|/.test(trimmed)) {
      i++
      continue
    }

    out.push(line)
    i++
  }

  // Clean up excess blank lines left by removed tables
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Sanitize assistant text shown after a student list card.
 * Strips markdown tables and trims text that's just restating
 * what the interactive card already shows.
 */
export function sanitizeStudentListAssistantText(text) {
  if (!text) return text

  // Remove markdown tables
  let cleaned = stripMarkdownTables(text)

  // If after stripping the response is empty or just whitespace, return empty
  if (!cleaned.trim()) return ''

  return cleaned
}