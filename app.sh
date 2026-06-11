#!/bin/bash
# Domino App launch file.
# Runs the Vite dev server (needed so the /api/* proxy to the Model APIs works)
# bound to 0.0.0.0 on the Domino app port.
set -e

# --- Node bootstrap ---------------------------------------------------------
# Use Node if the environment already provides it; otherwise download a
# prebuilt binary into the project (no sudo/apt required).
NODE_VERSION="v22.14.0"
NODE_PREFIX="/mnt/code/.node/node-${NODE_VERSION}-linux-x64"

if ! command -v node >/dev/null 2>&1; then
    if [ ! -x "${NODE_PREFIX}/bin/node" ]; then
        echo "Node not found — downloading ${NODE_VERSION}..."
        mkdir -p /mnt/code/.node
        curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
            | tar -xJ -C /mnt/code/.node
    fi
    export PATH="${NODE_PREFIX}/bin:${PATH}"
fi

echo "Using node $(node -v) / npm $(npm -v)"

cd /mnt/code/packages/web

# Port Domino's reverse proxy forwards to.
export PORT=8888

# Point the frontend at deployed Domino Model APIs (override in the App's
# environment variables, or in Project Settings). Falls back to local FastAPI.
# export YOLO_API_URL="https://<your-domino-host>/models/<model-id>/<version>/model"
# export ML_API_URL="https://<your-domino-host>/models/<model-id>/<version>/model"
# export MODEL_API_TOKEN="<model-api-access-token>"

npm install
npm run dev -- --host 0.0.0.0 --port "$PORT" --strictPort
