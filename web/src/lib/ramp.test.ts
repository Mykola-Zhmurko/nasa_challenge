import {describe, expect, it} from 'vitest'
import {
  FIRE_RAMP,
  FRP_CUTS,
  frpRampColor,
  frpStepIndex,
  frpStepLabels,
  rampColor,
  stepIndex,
} from '../../lib/ramp'

describe('colour ramp', () => {
  it('maps minimum and maximum values to different colours', () => {
    const peak = 100
    const minColour = rampColor(1, peak)
    const maxColour = rampColor(peak, peak)
    expect(minColour).not.toBe(maxColour)
    expect(minColour).toBe(FIRE_RAMP[0])
    expect(maxColour).toBe(FIRE_RAMP[FIRE_RAMP.length - 1])

    const cuts = FRP_CUTS
    const minFrpColour = frpRampColor(0.5, cuts)
    const maxFrpColour = frpRampColor(cuts[cuts.length - 1]!, cuts)
    expect(minFrpColour).not.toBe(maxFrpColour)
    expect(minFrpColour).toBe(FIRE_RAMP[0])
    expect(maxFrpColour).toBe(FIRE_RAMP[FIRE_RAMP.length - 1])
  })

  it('is monotonic: returned step index never decreases as value increases', () => {
    const peak = 100
    let prevStep = stepIndex(0, peak)
    for (let v = 0; v <= 150; v += 1) {
      const curStep = stepIndex(v, peak)
      expect(curStep).toBeGreaterThanOrEqual(prevStep)
      prevStep = curStep
    }

    const cuts = FRP_CUTS
    let prevFrpStep = frpStepIndex(0, cuts)
    for (let v = 0; v <= 150; v += 0.5) {
      const curFrpStep = frpStepIndex(v, cuts)
      expect(curFrpStep).toBeGreaterThanOrEqual(prevFrpStep)
      prevFrpStep = curFrpStep
    }
  })

  it('labels the five classes once, with rising bounds', () => {
    const labels = frpStepLabels()
    expect(labels).toHaveLength(FIRE_RAMP.length)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels[0]).toBe('0.0\u20132.5')
    expect(labels[labels.length - 1]).toBe('25.0\u2013100')
    const bounds = FRP_CUTS.map((_, index) => frpStepIndex(FRP_CUTS[index]!, FRP_CUTS))
    expect(bounds).toEqual([0, 1, 2, 3, 4])
  })

  it('returns the last colour for values above the maximum', () => {
    const peak = 100
    const lastColour = FIRE_RAMP[FIRE_RAMP.length - 1]
    expect(rampColor(101, peak)).toBe(lastColour)
    expect(rampColor(500, peak)).toBe(lastColour)
    expect(rampColor(10_000, peak)).toBe(lastColour)

    const cuts = FRP_CUTS
    expect(frpRampColor(101, cuts)).toBe(lastColour)
    expect(frpRampColor(1000, cuts)).toBe(lastColour)
  })
})
