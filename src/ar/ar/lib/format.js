const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const currencyFmtCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const numberFmt = new Intl.NumberFormat('en-US')

export function money(n, cents = false) {
  if (n == null || !Number.isFinite(n)) return ''
  return cents ? currencyFmtCents.format(n) : currencyFmt.format(n)
}

export function compactMoney(n) {
  if (n == null || !Number.isFinite(n)) return ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${Math.round(n)}`
}

export function num(n) {
  if (n == null || !Number.isFinite(n)) return ''
  return numberFmt.format(n)
}

export function shortDate(d) {
  if (!d) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function monthKey(d) {
  if (!d) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(key, opts = {}) {
  if (!key) return ''
  const [y, m] = key.split('-')
  const dt = new Date(parseInt(y), parseInt(m) - 1, 1)
  return dt.toLocaleDateString('en-US', {
    month: opts.long ? 'long' : 'short',
    year: opts.short ? '2-digit' : 'numeric',
  })
}

export function relativeTime(d) {
  if (!d) return ''
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`
  return d.toLocaleString()
}
