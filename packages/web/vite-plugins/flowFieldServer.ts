import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'

/**
 * Serves pre-computed CFD flow fields for `GET /api/wind-tunnel` directly from
 * the App's filesystem — the README's "app serves stored flow fields instantly"
 * design. Mirrors the nearest-match lookup in packages/ml/model_server.py so the
 * production App needs no separate ML service for the wind-tunnel view.
 *
 * Flow fields are JSON files named `{aircraft_id}_as{speed}_ws{wind}_wd{dir}.json`,
 * produced by the Ray CFD simulation. Directory resolution order:
 *   1. FLOW_FIELDS_DIR env var
 *   2. ../ml/flow_fields   (monorepo location the notebook writes to)
 *   3. ./flow_fields       (bundled into the web package for deploy)
 *
 * If no local flow fields exist, the request falls through to the configured
 * proxy (so local dev against model_server.py on :5051 still works).
 */
export function flowFieldServer(): Plugin {
    const candidates = [
        process.env.FLOW_FIELDS_DIR,
        path.resolve(__dirname, '../../ml/flow_fields'),
        path.resolve(__dirname, '../flow_fields'),
    ].filter(Boolean) as string[]

    const flowDir = candidates.find((d) => fs.existsSync(d))

    return {
        name: 'flow-field-server',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url || !req.url.startsWith('/api/wind-tunnel')) return next()
                // No local flow fields → let the proxy handle it (dev fallback).
                if (!flowDir) return next()

                const url = new URL(req.url, 'http://localhost')
                const q = url.searchParams
                const aircraftId = q.get('aircraft_id') || 'x47b'
                const aircraftSpeed = Number(q.get('aircraft_speed') ?? 200)
                const windSpeed = Number(q.get('wind_speed') ?? 0)
                const windDir = Number(q.get('wind_dir') ?? 0)

                const sendJson = (status: number, body: unknown) => {
                    res.statusCode = status
                    res.setHeader('Content-Type', 'application/json')
                    res.end(JSON.stringify(body))
                }

                let files: string[] = []
                try {
                    files = fs
                        .readdirSync(flowDir)
                        .filter((f) => f.startsWith(`${aircraftId}_`) && f.endsWith('.json'))
                } catch {
                    files = []
                }

                // Nearest match by parameter distance (matches model_server.py).
                let bestFile: string | null = null
                let bestDist = Infinity
                for (const f of files) {
                    const parts = f.replace('.json', '').split('_')
                    const fAs = parseFloat((parts[1] || '').replace('as', ''))
                    const fWs = parseFloat((parts[2] || '').replace('ws', ''))
                    const fWd = parseFloat((parts[3] || '').replace('wd', ''))
                    if (Number.isNaN(fAs) || Number.isNaN(fWs) || Number.isNaN(fWd)) continue
                    const dist =
                        Math.abs(fAs - aircraftSpeed) +
                        Math.abs(fWs - windSpeed) +
                        Math.abs(fWd - windDir)
                    if (dist < bestDist) {
                        bestDist = dist
                        bestFile = f
                    }
                }

                if (bestFile && bestDist < 100) {
                    try {
                        const data = JSON.parse(fs.readFileSync(path.join(flowDir, bestFile), 'utf-8'))
                        data.source = 'pre-computed'
                        data.file = bestFile
                        return sendJson(200, data)
                    } catch (err) {
                        return sendJson(500, { error: `Failed to read flow field: ${String(err)}` })
                    }
                }

                return sendJson(200, {
                    error:
                        `No pre-computed flow field for aircraft_speed=${aircraftSpeed}, ` +
                        `wind_speed=${windSpeed}, wind_dir=${windDir}. ` +
                        `Run the CFD simulation on the Ray cluster to generate data.`,
                    available_files: files,
                    streamlines: [],
                    frames: [],
                })
            })
        },
    }
}
