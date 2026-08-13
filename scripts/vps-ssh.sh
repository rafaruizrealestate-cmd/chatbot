#!/usr/bin/env bash
# SSH al VPS usando la clave del proyecto: .local/vps_ssh_key
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$ROOT/.local/vps_ssh_key"
HOST="${VPS_HOST:-187.124.47.44}"
USER="${VPS_USER:-root}"

if [[ ! -f "$KEY" ]]; then
  echo "Falta la clave: $KEY" >&2
  echo "Crea el archivo y pega la clave privada (ver .local/LEEME.txt)." >&2
  exit 1
fi

chmod 600 "$KEY" 2>/dev/null || true
exec ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "${USER}@${HOST}" "$@"
