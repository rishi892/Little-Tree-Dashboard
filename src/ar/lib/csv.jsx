// Export helpers. Two formats from one button:
//   • Professional report  - a branded, print-ready page (company logo + name,
//     report title, "As of" period, bold coloured header, zebra rows). Opens in
//     a new window and triggers the print dialog → "Save as PDF" gives a clean,
//     QuickBooks-style coloured report.
//   • Raw data (CSV)        - the plain spreadsheet export, unchanged.
import { useState, useRef, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { downloadXlsx } from './xlsx.js'

// ---------- shared ----------
function escapeCsv(v) {
  if (v == null) return ''
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
function cellText(v) {
  if (v == null) return ''
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// A column reads as numeric (→ right-aligned) when most of its cells look like
// money / counts / percentages.
const NUMERICISH = /^[$(]?-?[\d,]+(\.\d+)?\)?%?$|^-?\d+d$/
function numericColumns(headers, rows) {
  return headers.map((_, c) => {
    let num = 0, seen = 0
    for (const r of rows) {
      const t = cellText(r[c]).trim()
      if (!t) continue
      seen++
      if (NUMERICISH.test(t)) num++
    }
    return seen > 0 && num / seen >= 0.6
  })
}

// ---------- CSV ----------
function downloadCsv(filename, headers, rows) {
  const head = headers.map(escapeCsv).join(',')
  const body = rows.map((r) => r.map(escapeCsv).join(',')).join('\n')
  const blob = new Blob([head + '\n' + body], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ---------- Professional report (print → PDF) ----------
const BOOKS = {
  lt:     { logo: '/little-tree-logo.png', accent: '#15803d', accentDark: '#14532d', tint: '#f1f7f3' },
  gelato: { logo: '/Gelato.png',           accent: '#db2777', accentDark: '#9d174d', tint: '#fdf2f8' },
}
const COMPANY = 'Little Tree Confections'

function titleFromFilename(filename) {
  return String(filename || 'Report')
    .replace(/\.[a-z]+$/i, '')              // drop extension
    .replace(/[-_]\d{4}-\d{2}-\d{2}$/, '')  // drop trailing date stamp
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim() || 'Report'
}

function printReport({ filename, headers, rows, book = 'lt', title, period }) {
  const b = BOOKS[book] || BOOKS.lt
  const reportTitle = title || titleFromFilename(filename)
  const today = new Date()
  const longDate = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const periodLine = period || `As of ${longDate}`
  const numCols = numericColumns(headers, rows)
  const logoUrl = `${location.origin}${b.logo}`

  const thead = headers.map((h, i) =>
    `<th class="${numCols[i] ? 'num' : ''}">${escapeHtml(h)}</th>`).join('')
  const tbody = rows.map((r) => {
    const tds = headers.map((_, i) =>
      `<td class="${numCols[i] ? 'num' : ''}">${escapeHtml(cellText(r[i]))}</td>`).join('')
    return `<tr>${tds}</tr>`
  }).join('')

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(COMPANY)} - ${escapeHtml(reportTitle)}</title>
<style>
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; box-sizing: border-box; }
  @page { size: A4 landscape; margin: 12mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0f172a; font-size: 12px; padding: 22px; }
  .rpt-head { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid ${b.accent}; padding-bottom: 14px; margin-bottom: 4px; }
  .rpt-logo { height: 56px; width: auto; object-fit: contain; }
  .rpt-co { flex: 1; }
  .rpt-co-name { font-size: 20px; font-weight: 800; letter-spacing: -0.01em; color: ${b.accentDark}; }
  .rpt-title { font-size: 14px; font-weight: 700; margin-top: 2px; color: #0f172a; }
  .rpt-meta { text-align: right; font-size: 11px; color: #475569; line-height: 1.5; }
  .rpt-meta .period { font-weight: 700; color: ${b.accentDark}; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  thead th {
    background: ${b.accent}; color: #fff; font-weight: 700; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.03em; text-align: left;
    padding: 9px 10px; border: 1px solid ${b.accentDark};
  }
  thead th.num { text-align: right; }
  tbody td { padding: 7px 10px; border: 1px solid #e2e8f0; font-size: 11.5px; }
  tbody td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) td { background: ${b.tint}; }
  .rpt-foot { margin-top: 14px; font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; border-top: 1px solid #e2e8f0; padding-top: 8px; }
  @media print { body { padding: 0; } .rpt-foot { position: fixed; bottom: 0; left: 0; right: 0; } }
</style></head>
<body>
  <div class="rpt-head">
    <img class="rpt-logo" src="${logoUrl}" alt="" onerror="this.style.display='none'">
    <div class="rpt-co">
      <div class="rpt-co-name">${escapeHtml(COMPANY)}</div>
      <div class="rpt-title">${escapeHtml(reportTitle)}</div>
    </div>
    <div class="rpt-meta">
      <div class="period">${escapeHtml(periodLine)}</div>
      <div>${escapeHtml(rows.length.toLocaleString())} rows</div>
      <div>Generated ${escapeHtml(today.toLocaleString())}</div>
    </div>
  </div>
  <table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
  <div class="rpt-foot">
    <span>${escapeHtml(COMPANY)} · ${escapeHtml(reportTitle)}</span>
    <span>Confidential - internal use</span>
  </div>
  <script>window.onload = function () { setTimeout(function () { window.focus(); window.print(); }, 120); };</script>
</body></html>`

  const win = window.open('', '_blank')
  if (!win) {
    alert('Please allow pop-ups to download the report.')
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
}

// ---------- Button (report + CSV menu) ----------
export function ExportButton({ filename, headers, rows, label = 'Export', book, title, period }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const [pos, setPos] = useState(null)
  // Book: explicit prop wins; else fall back to whatever page the dashboard is on.
  const resolvedBook = book
    || (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lt_export_book'))
    || 'lt'

  const reportTitle = title || titleFromFilename(filename)
  const doReport = () => { setOpen(false); printReport({ filename, headers, rows, book: resolvedBook, title, period }) }
  const doExcel = () => { setOpen(false); downloadXlsx(filename, headers, rows, { book: resolvedBook, title: reportTitle, period }) }
  const doCsv = () => { setOpen(false); downloadCsv(filename, headers, rows) }

  // Portal the menu (fixed-positioned) so it is never clipped by a table's
  // overflow:auto - which made it look like the export button did nothing.
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const el = btnRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const W = 150, vw = window.innerWidth, vh = window.innerHeight
      let left = r.right - W
      if (left < 8) left = 8
      if (left + W > vw - 8) left = vw - 8 - W
      let top = r.bottom + 4
      const estH = 130
      if (top + estH > vh - 8 && r.top - 4 - estH > 8) top = r.top - 4 - estH
      setPos({ top, left, W })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => { window.removeEventListener('scroll', compute, true); window.removeEventListener('resize', compute) }
  }, [open])

  return (
    <span className="export-wrap">
      <button ref={btnRef} className="export-btn" onClick={() => setOpen((o) => !o)} title="Export">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>{label}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 2 }}>
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && pos && createPortal(
        <>
          <div className="export-backdrop" onClick={() => setOpen(false)} />
          <div className="export-menu" style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.W }} onClick={(e) => e.stopPropagation()}>
            <button onClick={doReport}><span>PDF</span><em>.pdf</em></button>
            <button onClick={doExcel}><span>Excel</span><em>.xlsx</em></button>
            <button onClick={doCsv}><span>CSV</span><em>.csv</em></button>
          </div>
        </>,
        document.body,
      )}
    </span>
  )
}
