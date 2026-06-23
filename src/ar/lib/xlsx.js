// Dependency-free .xlsx (OOXML) writer with a styled, branded report:
//   • A small title block (company name, report title, "As of" period)
//   • A bold, colour-filled header row (book accent - green LT / teal Gelato)
//   • Real numbers (currency / percent / days / counts) so Excel can sum & sort
//   • Zebra-free, thin-bordered table - clean and professional
//
// buildXlsx() returns the raw bytes (Uint8Array) - pure, so it can be unit
// tested in Node. downloadXlsx() wraps it with a browser download.

const ACCENTS = { lt: '15803D', gelato: 'DB2777' }
const ACCENT_DARK = { lt: '14532D', gelato: '9D174D' }
const COMPANY = 'Little Tree Confections'
const enc = new TextEncoder()

// ---------- value helpers ----------
function cellText(v) {
  if (v == null) return ''
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function colLetter(n) {
  let s = ''
  n += 1
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}

// Parse a display string ("$1,234.56", "(500)", "12.5%", "45d") to a number.
function toNum(t) {
  let s = String(t).trim()
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  s = s.replace(/[$,%\s]/g, '').replace(/d$/i, '')
  if (s.startsWith('-')) { neg = true; s = s.slice(1) }
  if (s === '' || isNaN(Number(s))) return null
  const n = Number(s)
  return neg ? -n : n
}

// Classify each column so we can store real numbers with the right format.
function analyzeColumns(headers, rows) {
  return headers.map((_, c) => {
    let seen = 0, cur = 0, pct = 0, days = 0, plain = 0, dec = false
    for (const r of rows) {
      const t = cellText(r[c]).trim()
      if (!t) continue
      seen++
      if (/^\(?-?\$[\d,]+(\.\d+)?\)?$/.test(t)) { cur++; if (t.includes('.')) dec = true }
      else if (/^-?[\d,]+(\.\d+)?%$/.test(t)) pct++
      else if (/^-?\d+(\.\d+)?d$/.test(t)) days++
      else if (/^\(?-?[\d,]+(\.\d+)?\)?$/.test(t)) { plain++; if (t.includes('.')) dec = true }
    }
    if (!seen || (cur + pct + days + plain) / seen < 0.6) return { type: 'text' }
    const max = Math.max(cur, pct, days, plain)
    if (max === cur) return { type: 'currency', dec }
    if (max === pct) return { type: 'percent' }
    if (max === days) return { type: 'days' }
    return { type: 'number', dec }
  })
}

// cellXfs style index for a column type (must match styles.xml order below).
function bodyStyle(col) {
  switch (col.type) {
    case 'currency': return col.dec ? 3 : 4
    case 'percent':  return 5
    case 'days':     return 6
    case 'number':   return col.dec ? 7 : 8
    default:         return 2 // text
  }
}

function stylesXml(book) {
  const accent = ACCENTS[book] || ACCENTS.lt
  const dark = ACCENT_DARK[book] || ACCENT_DARK.lt
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="6">
<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
<numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0"/>
<numFmt numFmtId="166" formatCode="0.0%"/>
<numFmt numFmtId="167" formatCode="0&quot;d&quot;"/>
<numFmt numFmtId="168" formatCode="#,##0.00"/>
<numFmt numFmtId="169" formatCode="#,##0"/>
</numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><color rgb="FF${dark}"/><name val="Calibri"/></font>
<font><b/><sz val="12"/><color rgb="FF0F172A"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF${accent}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="168" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="169" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`
}

function sheetXml(headers, rows, cols, meta) {
  const ncols = headers.length
  // Column widths from content length
  const widths = headers.map((h, c) => {
    let max = String(h).length
    for (const r of rows) max = Math.max(max, cellText(r[c]).length)
    return Math.min(60, Math.max(9, max * 1.05 + 2))
  })
  const colsXml = `<cols>${widths.map((w, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(2)}" customWidth="1"/>`).join('')}</cols>`

  const sCell = (ref, style, text) =>
    `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
  const nCell = (ref, style, val) => `<c r="${ref}" s="${style}"><v>${val}</v></c>`

  const rowsXml = []
  let rn = 1
  // Title block (text overflows into empty cells - looks like a banner)
  rowsXml.push(`<row r="${rn}" ht="22" customHeight="1">${sCell('A' + rn, 9, COMPANY)}</row>`); rn++
  rowsXml.push(`<row r="${rn}" ht="17" customHeight="1">${sCell('A' + rn, 10, meta.title)}</row>`); rn++
  rowsXml.push(`<row r="${rn}">${sCell('A' + rn, 11, meta.period)}  ${''}</row>`)
  // the period row above: keep simple single cell
  rowsXml[rowsXml.length - 1] = `<row r="${rn}">${sCell('A' + rn, 11, meta.period)}</row>`; rn++
  rowsXml.push(`<row r="${rn}"></row>`); rn++

  // Header row
  const headerRn = rn
  const headerCells = headers.map((h, c) => sCell(colLetter(c) + rn, 1, String(h))).join('')
  rowsXml.push(`<row r="${rn}" ht="20" customHeight="1">${headerCells}</row>`); rn++

  // Data rows
  for (const r of rows) {
    const cells = []
    for (let c = 0; c < ncols; c++) {
      const ref = colLetter(c) + rn
      const col = cols[c]
      const raw = cellText(r[c])
      if (col.type !== 'text' && raw.trim() !== '') {
        let n = toNum(raw)
        if (n != null) {
          if (col.type === 'percent') n = n / 100
          cells.push(nCell(ref, bodyStyle(col), n))
          continue
        }
      }
      cells.push(sCell(ref, bodyStyle(col), raw))
    }
    rowsXml.push(`<row r="${rn}">${cells.join('')}</row>`); rn++
  }

  const dim = `A1:${colLetter(Math.max(0, ncols - 1))}${rn - 1}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="${dim}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRn}" topLeftCell="A${headerRn + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${colsXml}
<sheetData>${rowsXml.join('')}</sheetData>
</worksheet>`
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

function workbookXml(sheetName) {
  const safe = String(sheetName).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Report'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(safe)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
}

// ---------- CRC32 + minimal ZIP (store, no compression) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF]
const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]

function zip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data
    const crc = crc32(data)
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0),
    ]
    parts.push(new Uint8Array(local), nameBytes, data)
    central.push({ crc, size: data.length, nameBytes, offset })
    offset += local.length + nameBytes.length + data.length
  }
  const centralStart = offset
  for (const c of central) {
    const rec = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(c.offset),
    ]
    parts.push(new Uint8Array(rec), c.nameBytes)
    offset += rec.length + c.nameBytes.length
  }
  const end = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length),
    ...u32(offset - centralStart), ...u32(centralStart), ...u16(0),
  ]
  parts.push(new Uint8Array(end))

  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) { out.set(p, pos); pos += p.length }
  return out
}

// ---------- public ----------
export function buildXlsx(headers, rows, { book = 'lt', title = 'Report', period } = {}) {
  const longDate = new Date().toISOString().slice(0, 10)
  const meta = { title: String(title), period: period || `As of ${longDate}` }
  const cols = analyzeColumns(headers, rows)
  const files = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(meta.title) },
    { name: 'xl/_rels/workbook.xml.rels', data: WB_RELS },
    { name: 'xl/styles.xml', data: stylesXml(book) },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(headers, rows, cols, meta) },
  ]
  return zip(files)
}

export function downloadXlsx(filename, headers, rows, opts = {}) {
  const bytes = buildXlsx(headers, rows, opts)
  const name = String(filename || 'report').replace(/\.[a-z]+$/i, '') + '.xlsx'
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
