#!/usr/bin/env bash
# Run API with reload — excludes venv so pip/site-packages changes don't restart the server in a loop.
set -euo pipefail
cd "$(dirname "$0")"
exec uvicorn main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --reload \
  --reload-dir routes \
  --reload-dir services \
  --reload-include 'main.py' \
  --reload-exclude 'venv/*' \
  --reload-exclude '*/venv/*'
