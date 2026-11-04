#!/bin/bash
set -e
cd /mnt/code/packages/web
npm install --no-audit --no-fund
npm run build
exec npx vite preview --host 0.0.0.0 --port 8888 --strictPort
