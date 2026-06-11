#!/bin/bash
# Domino App launch file.
# Runs the Vite dev server (needed so the /api/* proxy to the Model APIs works)
# bound to 0.0.0.0 on the Domino app port.
set -e

cd /mnt/code/packages/web

# Port Domino's reverse proxy forwards to.
export PORT=8888

# Point the frontend at deployed Domino Model APIs (override in the App's
# environment variables, or in Project Settings). Falls back to local FastAPI.
# export YOLO_API_URL="https://<your-domino-host>/models/<model-id>/<version>/model"
# export ML_API_URL="https://<your-domino-host>/models/<model-id>/<version>/model"
# export MODEL_API_TOKEN="<model-api-access-token>"

npm ci
npm run dev -- --host 0.0.0.0 --port "$PORT" --strictPort
