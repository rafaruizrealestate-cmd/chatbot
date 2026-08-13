#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "[1/7] Node 20 y herramientas de compilacion"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y build-essential python3.12-venv python3.12-dev
node -v
npm -v

echo "[2/7] Permisos y directorios"
chmod 600 /opt/whatsapp-chatbot-951/.env /opt/whatsapp-chatbot-951/voice-agent/.env \
  /opt/livekit-mambo/.env /opt/livekit-mambo/livekit.yaml
chmod +x /opt/whatsapp-chatbot-951/scripts/*.sh
mkdir -p /opt/whatsapp-chatbot-951/data/voice-recordings /var/lib/manuel-health

echo "[3/7] npm ci + build"
cd /opt/whatsapp-chatbot-951
npm ci
npm run build

echo "[4/7] LiveKit SIP"
cp /opt/whatsapp-chatbot-951/deploy/livekit/docker-compose.yml /opt/livekit-mambo/docker-compose.yml
cd /opt/livekit-mambo
docker compose up -d
if ! command -v lk >/dev/null 2>&1; then
  curl -sSL https://get.livekit.io/cli | bash
fi

echo "[5/7] venv agente de voz"
cd /opt/whatsapp-chatbot-951/voice-agent
python3.12 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python agent.py download-files || true

echo "[6/7] systemd"
cp /opt/whatsapp-chatbot-951/deploy/whatsapp-chatbot-951.service.example /etc/systemd/system/whatsapp-chatbot-951.service
cp /opt/whatsapp-chatbot-951/deploy/manuel-voice-agent.service.example /etc/systemd/system/manuel-voice-agent.service
systemctl daemon-reload
systemctl enable --now whatsapp-chatbot-951
sleep 3
systemctl enable --now manuel-voice-agent
sleep 4

echo "[7/7] estado"
systemctl is-active whatsapp-chatbot-951 || true
systemctl is-active manuel-voice-agent || true
curl -sf http://127.0.0.1:3002/health || echo "health FAIL"
cd /opt/livekit-mambo && docker compose ps
echo BOOTSTRAP_DONE
