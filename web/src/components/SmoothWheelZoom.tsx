import {useEffect} from 'react'
import {useMap} from 'react-leaflet'
import type {LatLng} from 'leaflet'
import {wheelZoomDelta} from '../../lib/zoom'

/** Time constant of the exponential glide in ms. */
const GLIDE_MS = 60

/** Idle time after the last wheel event before the gesture is settled. */
const SETTLE_MS = 140

/** Remaining distance (in zoom levels) treated as arrived. */
const ARRIVED = 0.002

/**
 * Leaflet exposes no public API for a fractional, interruptible zoom; this
 * mirrors Leaflet's internal TouchZoom continuous-zoom path.
 */
type MapInternals = {
  _move: (center: LatLng, zoom: number, data?: {pinch?: boolean; round?: boolean}) => void
  _animateZoom: (center: LatLng, zoom: number, startAnim: boolean, noUpdate?: unknown) => void
  _onZoomTransitionEnd: () => void
  _animatingZoom?: boolean
}

export function SmoothWheelZoom() {
  const map = useMap()

  useEffect(() => {
    map.scrollWheelZoom.disable()
    const internals = map as unknown as MapInternals
    const container = map.getContainer()

    let current = map.getZoom()
    let target = current
    let anchor = map.getCenter()
    let anchorPoint = map.getSize().divideBy(2)
    let frame = 0
    let lastTime = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined

    const step = () => {
      const now = performance.now()
      const dt = Math.min(64, Math.max(0, now - lastTime))
      lastTime = now
      const k = 1 - Math.exp(-dt / GLIDE_MS)
      current += (target - current) * k
      const arrived = Math.abs(target - current) < ARRIVED
      if (arrived) current = target

      const center = map.unproject(
        map.project(anchor, current).subtract(anchorPoint.subtract(map.getSize().divideBy(2))),
        current,
      )
      internals._move(center, current, {pinch: true, round: false})

      if (arrived) {
        frame = 0
        settleTimer = setTimeout(() => {
          settleTimer = undefined
          const settledCenter = map.unproject(
            map.project(anchor, target).subtract(anchorPoint.subtract(map.getSize().divideBy(2))),
            target,
          )
          // Leaflet's TouchZoom passes `zoomSnap` here to skip the tile update when the zoom is
          // snapped; we keep the fractional target, so the tile layers have to update (0).
          internals._animateZoom(settledCenter, target, true, 0)
        }, SETTLE_MS)
        return
      }

      frame = requestAnimationFrame(step)
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (internals._animatingZoom) {
        internals._onZoomTransitionEnd()
      }
      if (!frame && settleTimer === undefined) {
        current = map.getZoom()
        target = current
      }
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer)
        settleTimer = undefined
      }
      const next = target + wheelZoomDelta(event.deltaY, event.deltaMode)
      target = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), next))
      anchor = map.mouseEventToLatLng(event)
      anchorPoint = map.mouseEventToContainerPoint(event)
      if (!frame) {
        lastTime = performance.now()
        frame = requestAnimationFrame(step)
      }
    }

    const cancel = () => {
      if (frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer)
        settleTimer = undefined
      }
      current = map.getZoom()
      target = current
    }

    container.addEventListener('wheel', onWheel, {passive: false})
    map.on('dragstart', cancel)

    return () => {
      container.removeEventListener('wheel', onWheel)
      map.off('dragstart', cancel)
      if (frame) cancelAnimationFrame(frame)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      map.scrollWheelZoom.enable()
    }
  }, [map])

  return null
}
