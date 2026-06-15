#!/bin/bash
# Domino App launch file for the YOLO + OpenAI intel service.
# Serves /detect (YOLOv8 image upload) and /analyze (GPT intel report).
set -e

cd /mnt/code/packages/python-yolo

pip install -q -r requirements.txt

# OPENAI_API_KEY must be set via Domino App environment variables.
# Prefer routing through the Domino AI Gateway:
#   export OPENAI_API_KEY="<gateway-key>"

export PORT=8888
python main.py
