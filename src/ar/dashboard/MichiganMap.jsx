// Michigan sales map (Leaflet + OpenStreetMap).
// Two modes: "city" plots one 📍 per city; "region" plots one 📍 per
// region at its centroid, sized by total regional sales. Switching the
// Geography tab's view toggle swaps the markers instantly.

import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { MapContainer, TileLayer, Marker, Tooltip, ZoomControl, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { CITY_COORDS } from '../lib/cityCoords.js'
import { compactMoney, money, num } from '../lib/format.js'

const REGION_COLOR = {
  'Upper Peninsula': '#7c3aed',
  'Northern Lower':  '#0891b2',
  'West':            '#0d9488',
  'Southwest':       '#65a30d',
  'Central':         '#ca8a04',
  'East':            '#ea580c',
  'South Central':   '#db2777',
  'Southeast':       '#15803d',
  'Other':           '#94a3b8',
}

// Approximate geographic centroid of each region - used when the map
// is in "region" mode so the pin sits roughly in the middle of the area.
const REGION_CENTROID = {
  'Upper Peninsula': { lat: 46.40, lon: -87.50 },
  'Northern Lower':  { lat: 44.75, lon: -84.80 },
  'West':            { lat: 43.00, lon: -85.85 },
  'Southwest':       { lat: 42.10, lon: -85.55 },
  'Central':         { lat: 43.05, lon: -84.55 },
  'East':            { lat: 43.20, lon: -83.55 },
  'South Central':   { lat: 41.95, lon: -84.65 },
  'Southeast':       { lat: 42.45, lon: -83.20 },
}

// Full-state fallback bounds (used only if there are zero pins to fit)
const MI_BOUNDS = [
  [41.6, -90.6],
  [47.6, -82.2],
]

// Auto-fits the map to whatever pins are currently rendered. Re-runs when
// the user toggles view (region ↔ city) so the camera always frames the
// active dataset, not the whole state.
function FitToPins({ pins }) {
  const map = useMap()
  useEffect(() => {
    if (!pins.length) {
      map.flyToBounds(MI_BOUNDS, { duration: 0.5 })
      return
    }
    const latlngs = pins.map((p) => [p.lat, p.lon])
    const bounds = L.latLngBounds(latlngs)
    // padding so pins near the edge aren't cropped under the zoom controls
    map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 11, duration: 0.5 })
  }, [pins, map])
  return null
}

// Renders a teardrop pin using the literal 📍 emoji. The chip behind
// the emoji's head indicates the region color.
function pinIcon({ color, size, isTop }) {
  const halo = isTop
    ? `<span class="mi-pin-halo" style="background:${color}"></span>`
    : ''
  const html = `
    <div class="mi-pin-wrap" style="font-size:${size}px;">
      ${halo}
      <span class="mi-pin-region" style="background:${color};"></span>
      <span class="mi-pin-emoji">📍</span>
    </div>
  `
  return L.divIcon({
    html,
    className: 'mi-pin-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    tooltipAnchor: [0, -size],
  })
}

export default function MichiganMap({
  view = 'city',
  regions = [],
  cities = [],
  onCityClick,
  onRegionClick,
}) {
  const mapRef = useRef(null)

  // Build the pin list for the current view. Each entry has the fields
  // the renderer needs (lat/lon/color/size/labels) regardless of mode.
  const pins = useMemo(() => {
    if (view === 'region') {
      if (!regions.length) return []
      const max = Math.max(...regions.map((r) => r.sales), 1)
      const sorted = [...regions].sort((a, b) => b.sales - a.sales)
      const topCutoff = sorted[1]?.sales || Infinity // top 2 regions pulse
      return sorted
        .map((r) => {
          const c = REGION_CENTROID[r.region]
          if (!c) return null
          const ratio = Math.log10(r.sales + 1) / Math.log10(max + 1)
          // Region pins are bigger since there are fewer of them
          const size = Math.round(28 + ratio * 22) // 28..50px
          return {
            kind: 'region',
            key: r.region,
            label: r.region + ' Michigan',
            sublabel: `${r.customerCount} customers · ${num(r.invoices)} invoices`,
            sales: r.sales,
            lat: c.lat,
            lon: c.lon,
            color: REGION_COLOR[r.region] || '#94a3b8',
            size,
            isTop: r.sales >= topCutoff,
            region: r.region,
          }
        })
        .filter(Boolean)
    }

    // view === 'city'
    if (!cities.length) return []
    const max = Math.max(...cities.map((c) => c.sales), 1)
    const sorted = [...cities].sort((a, b) => b.sales - a.sales)
    const topCutoff = sorted[2]?.sales || Infinity
    return sorted
      .map((c) => {
        const coords = CITY_COORDS[c.city]
        if (!coords) return null
        const ratio = Math.log10(c.sales + 1) / Math.log10(max + 1)
        const size = Math.round(14 + ratio * 14) // 14..28px
        return {
          kind: 'city',
          key: `${c.region}|${c.city}`,
          label: c.city,
          sublabel: `${c.customerCount} customers · ${num(c.invoices)} invoices`,
          regionLabel: `${c.region} Michigan`,
          sales: c.sales,
          lat: coords.lat,
          lon: coords.lon,
          color: REGION_COLOR[c.region] || '#94a3b8',
          size,
          isTop: c.sales >= topCutoff,
          city: c.city,
          region: c.region,
        }
      })
      .filter(Boolean)
  }, [view, regions, cities])

  const handlePinClick = (p) => {
    const map = mapRef.current
    if (map) {
      const targetZoom = p.kind === 'region' ? 8 : 10
      map.flyTo([p.lat, p.lon], targetZoom, { duration: 0.6 })
    }
    setTimeout(() => {
      if (p.kind === 'region') onRegionClick && onRegionClick(p.region)
      else onCityClick && onCityClick(p.city, p.region)
    }, 350)
  }

  const resetView = () => {
    const map = mapRef.current
    if (!map) return
    if (!pins.length) {
      map.flyToBounds(MI_BOUNDS, { duration: 0.6 })
      return
    }
    const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lon]))
    map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 11, duration: 0.6 })
  }

  const sourceCount = view === 'region' ? regions.length : cities.length
  const unmapped = sourceCount - pins.length
  const topPin = pins[0]

  return (
    <div className="mi-map-wrap">
      <div className="mi-map-card">
        <div className="mi-map-head">
          <div>
            <h3>Sales across Michigan</h3>
            <span className="mi-map-sub">
              {num(pins.length)} {view === 'region' ? 'regions' : 'cities'} ·
              pin size = lifetime sales · click any pin
              {topPin && ` · #1 ${topPin.label.replace(' Michigan', '')} ${compactMoney(topPin.sales)}`}
            </span>
          </div>
          <button className="mi-map-reset" onClick={resetView} title="Reset view to whole state">
            ⤺ Reset view
          </button>
        </div>

        <div className="mi-map-leaflet">
          <MapContainer
            bounds={MI_BOUNDS}
            scrollWheelZoom
            zoomControl={false}
            className="mi-leaflet-canvas"
            ref={mapRef}
          >
            <ZoomControl position="topright" />
            <FitToPins pins={pins} />
            <TileLayer
              attribution='© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={18}
            />
            {pins.map((p) => (
              <Marker
                key={p.key}
                position={[p.lat, p.lon]}
                icon={pinIcon({ color: p.color, size: p.size, isTop: p.isTop })}
                zIndexOffset={p.isTop ? 1000 : Math.round(p.size * 10)}
                eventHandlers={{ click: () => handlePinClick(p) }}
              >
                <Tooltip direction="top" offset={[0, -4]} opacity={1}>
                  <div className="mi-tip">
                    <div className="mi-tip-city">{p.label}</div>
                    {p.regionLabel && (
                      <div className="mi-tip-region" style={{ color: p.color }}>
                        {p.regionLabel}
                      </div>
                    )}
                    <div className="mi-tip-sales">{money(p.sales)}</div>
                    <div className="mi-tip-sub">{p.sublabel}</div>
                  </div>
                </Tooltip>
              </Marker>
            ))}
          </MapContainer>
        </div>

        <div className="mi-map-legend">
          {Object.entries(REGION_COLOR).filter(([r]) => r !== 'Other').map(([region, color]) => (
            <span key={region} className="mi-legend-item">
              <span className="mi-legend-dot" style={{ background: color }} />
              {region}
            </span>
          ))}
          {unmapped > 0 && (
            <span className="mi-legend-note">
              {unmapped} {view === 'region' ? 'regions' : 'cities'} without coordinates
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
