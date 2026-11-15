import type {BBox} from '../../lib/api'
import type {DateWindow} from '../../lib/range'
import type {TimeRangePreset} from '../components/ControlPanel'
import type {Basemap, SensorsEnabled} from '../components/MapView'

export interface ShareState {
  bbox: BBox
  day: string | null
  rangePreset: TimeRangePreset
  customRange: DateWindow | null
  res: number
  pinnedRes: number | null
  basemap: Basemap
  sensorsEnabled: SensorsEnabled
}

export function buildShareUrl(baseUrl: string, state: ShareState): string {
  const params = new URLSearchParams()
  params.set('bbox', state.bbox.map(n => Number(n.toFixed(4))).join(','))
  if (state.day) {
    params.set('day', state.day)
  } else if (state.rangePreset === 'custom' && state.customRange) {
    params.set('from', state.customRange.from)
    params.set('to', state.customRange.to)
  } else {
    params.set('range', state.rangePreset === 'day' ? '7d' : state.rangePreset)
  }
  params.set('res', state.pinnedRes === null ? 'auto' : String(state.res))
  params.set('basemap', state.basemap)
  const activeSensors = [
    state.sensorsEnabled.MODIS ? 'MODIS' : null,
    state.sensorsEnabled.VIIRS ? 'VIIRS' : null,
  ].filter(Boolean)
  params.set('sensors', activeSensors.join(','))
  return `${baseUrl}?${params.toString()}`
}
