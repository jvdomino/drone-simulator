import path from 'path'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import react from '@vitejs/plugin-react'
import { flowFieldServer } from './vite-plugins/flowFieldServer'

const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesium'

// Port Domino's reverse proxy forwards to (any port works; 8888 is the convention).
const PORT = Number(process.env.PORT) || 4000

// Backend targets. Locally these are the FastAPI services on 5050/5051.
// In Domino, point them at deployed Model API invocation URLs via these env vars.
const YOLO_TARGET = process.env.YOLO_API_URL || 'http://localhost:5050'
const ML_TARGET = process.env.ML_API_URL || 'http://localhost:5051'
// Optional bearer token forwarded to Model APIs (e.g. a Domino Model API access token).
const API_TOKEN = process.env.MODEL_API_TOKEN

const withAuth = (target: string) => ({
    target,
    changeOrigin: true,
    configure: (proxy: any) => {
        if (!API_TOKEN) return
        proxy.on('proxyReq', (proxyReq: any) => {
            proxyReq.setHeader('Authorization', `Bearer ${API_TOKEN}`)
        })
    },
})

export default defineConfig({
    plugins: [
        react(),
        // Serves /api/wind-tunnel from pre-computed CFD JSON (falls through to
        // the proxy below when no local flow fields are bundled).
        flowFieldServer(),
        viteStaticCopy({
            targets: [
                { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
                { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
                { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
                { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
            ],
        }),
    ],
    define: {
        CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
    },
    // CRITICAL for the Domino reverse proxy: emit relative asset URLs.
    base: './',
    envDir: path.resolve(__dirname, '../..'),
    preview: {
        host: '0.0.0.0',
        port: PORT,
        strictPort: true,
        allowedHosts: true,
    },
    server: {
        host: '0.0.0.0',
        port: PORT,
        strictPort: true,
        allowedHosts: true,
        proxy: {
            // YOLO detection + GPT intel report. Point YOLO_API_URL at the YOLO
            // sidecar App (FastAPI), whose /detect and /analyze routes match these
            // 1:1 — no request reshaping needed (multipart image passes through).
            '/api/detect': {
                ...withAuth(YOLO_TARGET),
                rewrite: (path) => path.replace(/^\/api\/detect/, '/detect'),
            },
            '/api/analyze': {
                ...withAuth(YOLO_TARGET),
                rewrite: (path) => path.replace(/^\/api\/analyze/, '/analyze'),
            },
            // Wind correction — proxied to ML_API_URL (Domino Model API or local
            // model_server.py:5051). Set VITE_MODEL_API_FORMAT=domino when pointing
            // at a Domino Model API so WindCorrectionClient wraps the envelope.
            '/api/wind-correct': {
                ...withAuth(ML_TARGET),
                rewrite: (path) => path.replace(/^\/api\/wind-correct/, '/wind-correct'),
            },
            // Wind-tunnel is served by flowFieldServer() above when flow fields are
            // bundled; this proxy is the dev fallback to model_server.py on :5051.
            '/api/wind-tunnel': {
                ...withAuth(ML_TARGET),
                rewrite: (path) => path.replace(/^\/api\/wind-tunnel/, '/wind-tunnel'),
            },
        },
    },
})