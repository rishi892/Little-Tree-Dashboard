import { loadAll } from '../src/ar/lib/sheets.js'
const data = await loadAll()
const clean = v => String(v||'').replace(/^(Little Tree|Gelato)-\s*/i,'').trim()
// distinct store names (wholesale + gelato), pick a varied sample
const names = [...new Set([...data.invoices, ...(data.gelato||[])].map(r=>clean(r.vendor)).filter(n=>n&&n!=='VOID'))]
const sample = names.slice(0, 12)
const sleep = ms => new Promise(r=>setTimeout(r,ms))
console.log('Testing', sample.length, 'stores via Nominatim (OSM)...\n')
for (const name of sample) {
  const q = encodeURIComponent(name + ', Michigan, USA')
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=us&addressdetails=1`, {
      headers: { 'User-Agent': 'LittleTreeAR-geocode-test/1.0 (infiaiedge@gmail.com)' }
    })
    const j = await res.json()
    if (j[0]) {
      const a = j[0]
      console.log(`✓ ${name.padEnd(38).slice(0,38)} → ${(+a.lat).toFixed(4)},${(+a.lon).toFixed(4)}  [${a.type}] ${a.display_name.split(',').slice(0,3).join(',')}`)
    } else {
      console.log(`✗ ${name.padEnd(38).slice(0,38)} → NOT FOUND`)
    }
  } catch(e){ console.log(`! ${name} → ${e.message}`) }
  await sleep(1100) // respect 1 req/sec
}
