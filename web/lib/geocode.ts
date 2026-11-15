import type {BBox} from './api'

export interface PlaceSuggestion {
  id: string
  /** Main label, e.g. "Wuerzburg" (always plain ASCII). */
  name: string
  /** Region / country line under the label, e.g. "Bavaria, Germany". */
  detail: string
  /** True when the row is a raw coordinate pair typed by the user. */
  isCoords: boolean
  lat: number
  lon: number
  /** Bounds around the city, sized by its population. */
  bbox: BBox | null
}

interface OpenMeteoResult {
  name?: string
  latitude?: number
  longitude?: number
  country?: string
  admin1?: string
  admin2?: string
  population?: number
  /** GeoNames feature code: PPL* = populated place, PCLI = country, ADM* = region. */
  feature_code?: string
}

/**
 * City search through Open-Meteo's GeoNames index (no key, CORS `*`).
 * Only populated places are offered, the way the NASA FIRMS map behaves:
 * countries, regions and streets never appear as a hit.
 */
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const MIN_CHARS = 2
const LIMIT = 8

const UMLAUTS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'Ae',
  Ö: 'Oe',
  Ü: 'Ue',
  ß: 'ss',
  æ: 'ae',
  Æ: 'Ae',
  œ: 'oe',
  Œ: 'Oe',
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  þ: 'th',
  Þ: 'Th',
  ı: 'i',
  İ: 'I',
}

const TRANSLITERATION = new RegExp(`[${Object.keys(UMLAUTS).join('')}]`, 'g')

/**
 * Plain ASCII spelling of a place name: German umlauts keep their sound
 * (ü → ue), every other accent is dropped (é → e). The search box and the
 * suggestion list never show ä/ö/ü/ß, so "Würzburg" reads "Wuerzburg".
 */
export function toAscii(value: string): string {
  const expanded = value.replace(TRANSLITERATION, ch => UMLAUTS[ch] ?? ch)
  const stripped = expanded
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // A name written only in a non-Latin script would vanish; keep it as typed.
  return stripped || value.trim()
}

/** Accent-free query: ü → u, so "Würzburg" and "Wurzburg" hit the same entry. */
function foldForSearch(value: string): string {
  return value
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/** "Wuerzburg" → "Wurzburg": the geocoder only knows the umlaut or the plain vowel. */
function collapseDigraphs(value: string): string {
  return value.replace(/ae|oe|ue/gi, match => match.charAt(0))
}

function isPopulatedPlace(code: string | undefined): boolean {
  return typeof code === 'string' && code.startsWith('PPL')
}

function clampBox(box: [number, number, number, number]): BBox | null {
  const [minLon, minLat, maxLon, maxLat] = box
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null
  const west = Math.max(-180, Math.min(180, minLon))
  const east = Math.max(-180, Math.min(180, maxLon))
  const south = Math.max(-90, Math.min(90, minLat))
  const north = Math.max(-90, Math.min(90, maxLat))
  if (west >= east || south >= north) return null
  return [west, south, east, north]
}

/** Bounds around a single point; used for coordinates and as a fallback. */
export function boxAroundPoint(lat: number, lon: number, delta = 0.35): BBox | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const round = (value: number) => Number(value.toFixed(4))
  return clampBox([round(lon - delta), round(lat - delta), round(lon + delta), round(lat + delta)])
}

/** The bigger the city, the wider the box the map opens on. */
export function boxForCity(lat: number, lon: number, population = 0): BBox | null {
  const delta = population >= 500_000 ? 0.4 : population >= 50_000 ? 0.22 : 0.1
  return boxAroundPoint(lat, lon, delta)
}

function buildDetail(result: OpenMeteoResult, name: string): string {
  const parts = [result.admin1, result.country]
  const seen = new Set<string>([name.toLowerCase()])
  const kept: string[] = []
  for (const part of parts) {
    if (!part) continue
    const text = toAscii(part)
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    kept.push(text)
  }
  return kept.slice(0, 2).join(', ')
}

/** One request against the geocoder, already cleaned up and de-duplicated. */
async function fetchPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=${LIMIT}&language=en&format=json`
  const response = await fetch(url, {signal, headers: {Accept: 'application/json'}})
  if (!response.ok) return []
  const data = (await response.json()) as {results?: OpenMeteoResult[]}
  const results = data.results ?? []
  const out: PlaceSuggestion[] = []
  const seen = new Set<string>()
  for (const result of results) {
    if (!isPopulatedPlace(result.feature_code)) continue
    const lat = result.latitude
    const lon = result.longitude
    if (!result.name || typeof lat !== 'number' || typeof lon !== 'number') continue
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    const name = toAscii(result.name)
    const detail = buildDetail(result, name)
    const key = `${name}|${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: key,
      name,
      detail,
      isCoords: false,
      lat,
      lon,
      bbox: boxForCity(lat, lon, result.population ?? 0),
    })
  }
  return out
}

function mergePlaces(lists: PlaceSuggestion[][]): PlaceSuggestion[] {
  const out: PlaceSuggestion[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      out.push(row)
    }
  }
  return out.slice(0, LIMIT)
}

/**
 * City suggestions for the search box, ranked the way the geocoder ranks them.
 * Typing "Würzburg", "Wurzburg" or "Wuerzburg" all find the same city; the
 * ae/oe/ue spelling is asked for as a plain vowel first, because that is the
 * city the user means ("Muenchen" → Munich, not Muenchendorf).
 */
export async function suggestPlaces(query: string, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
  const trimmed = query.trim()
  if (trimmed.length < MIN_CHARS) return []

  const plain = [...new Set([trimmed, foldForSearch(trimmed)].filter(Boolean))]
  const collapsed = collapseDigraphs(trimmed)
  const variants = collapsed && !plain.includes(collapsed) ? [collapsed, ...plain] : plain
  return mergePlaces(await Promise.all(variants.map(text => fetchPlaces(text, signal))))
}

/** Parses "48.5, 9.2" / "48.5 9.2" typed into the search box. */
export function parseCoordinates(raw: string): {lat: number; lon: number} | null {
  const match = raw
    .trim()
    .match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/)
  if (!match) return null
  const lat = Number(match[1])
  const lon = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return {lat, lon}
}
