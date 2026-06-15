import * as Cesium from 'cesium'

export interface WindCorrectionRates {
  headingRate: number   // rad/s — add to heading to counteract wind drift
  throttleRate: number  // m/s² — add to speed to counteract drag
}

interface StateSnapshot {
  aircraft: {
    speed: number           // m/s
    heading: number         // radians
    pitch: number           // radians
    roll: number            // radians
    verticalVelocity: number
  }
  wind: {
    direction: number       // degrees
    speed: number           // m/s
    turbulence: number      // 0–1
  }
}

// Set VITE_MODEL_API_FORMAT=domino to wrap/unwrap the Domino Model API envelope.
// Default 'raw' matches model_server.py's plain JSON endpoint.
const IS_DOMINO_MODEL_API = import.meta.env.VITE_MODEL_API_FORMAT === 'domino'

export class WindCorrectionClient {
  private rates: WindCorrectionRates = { headingRate: 0, throttleRate: 0 }
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight = false
  private readonly POLL_MS = 500
  private readonly aircraftId: string

  constructor(aircraftId: string) {
    this.aircraftId = aircraftId
  }

  start(getState: () => StateSnapshot): void {
    if (this.timer) return
    this.poll(getState)  // immediate first call
    this.timer = setInterval(() => this.poll(getState), this.POLL_MS)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.rates = { headingRate: 0, throttleRate: 0 }
  }

  getRates(): WindCorrectionRates {
    return this.rates
  }

  private async poll(getState: () => StateSnapshot): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    try {
      const { aircraft, wind } = getState()

      const payload = {
        aircraft_id: this.aircraftId,
        speed: aircraft.speed,
        heading: Cesium.Math.toDegrees(aircraft.heading),
        pitch: Cesium.Math.toDegrees(aircraft.pitch),
        roll: Cesium.Math.toDegrees(aircraft.roll),
        vertical_velocity: aircraft.verticalVelocity,
        wind_dir: wind.direction,
        wind_speed: wind.speed,
        turbulence: wind.turbulence,
      }

      const body = IS_DOMINO_MODEL_API
        ? JSON.stringify({ data: payload })
        : JSON.stringify(payload)

      const res = await fetch('/api/wind-correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(400),  // drop if API slower than next poll
      })

      if (!res.ok) return

      const json = await res.json()
      // Accept both raw {corrections} and Domino Model API {result: {corrections}}
      const corrections = json.result?.corrections ?? json.corrections
      if (!corrections) return

      // Convert one-shot correction values into per-second rates so each
      // game-loop frame applies `rate * deltaTime` — spreading the correction
      // smoothly across the poll interval.
      const pollSec = this.POLL_MS / 1000
      this.rates = {
        headingRate: Cesium.Math.toRadians(corrections.heading_correction ?? 0) / pollSec,
        throttleRate: (corrections.throttle_correction ?? 0) / pollSec,
      }
    } catch {
      // API unavailable — hold last corrections; caller clamps speed to [min,max]
    } finally {
      this.inflight = false
    }
  }
}
