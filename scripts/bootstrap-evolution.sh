#!/usr/bin/env bash
set -euo pipefail
cd /opt/evolution-api
docker compose up -d
echo "Esperando Evolution..."
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8080/ >/dev/null 2>&1 || curl -sf http://127.0.0.1:8080/manager >/dev/null 2>&1; then
    echo "Evolution responde"
    break
  fi
  sleep 3
done
API_KEY=$(grep '^AUTHENTICATION_API_KEY=' /opt/evolution-api/.env | cut -d= -f2-)
# Crear instancia si no existe
EXIST=$(curl -sS -H "apikey: ${API_KEY}" http://127.0.0.1:8080/instance/fetchInstances || true)
if echo "$EXIST" | grep -q '"name":"mambo"\|"instanceName":"mambo"'; then
  echo "Instancia mambo ya existe"
else
  echo "Creando instancia mambo"
  curl -sS -X POST http://127.0.0.1:8080/instance/create \
    -H "apikey: ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
      "instanceName": "mambo",
      "qrcode": true,
      "integration": "WHATSAPP-BAILEYS",
      "webhook": {
        "enabled": true,
        "url": "http://186.240.156.33:3002/webhook",
        "byEvents": false,
        "base64": true,
        "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"]
      }
    }' | head -c 400
  echo
fi
echo "--- estado ---"
curl -sS -H "apikey: ${API_KEY}" http://127.0.0.1:8080/instance/connectionState/mambo || true
echo
docker compose ps
echo EVOLUTION_UP
