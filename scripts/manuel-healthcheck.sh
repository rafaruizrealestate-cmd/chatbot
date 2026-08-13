#!/usr/bin/env bash
# Healthcheck + auto-heal de Manuel (WhatsApp 614 + voz 951).
# Uso: bash scripts/manuel-healthcheck.sh [--no-heal]
# Coste: ~1–2 s CPU sin reparaciones. Ideal en cron/timer cada hora.
#
# Auto-heal: solo acciones de la lista cerrada de abajo, con límite de intentos
# por ventana para no entrar en bucle de reinicios. Evolution (QR/sesión) NUNCA
# se toca automáticamente: requiere intervención humana.
set -u

ROOT="${MANUEL_ROOT:-/opt/whatsapp-chatbot-951}"
LIVEKIT_DIR="${MANUEL_LIVEKIT_DIR:-/opt/livekit-manuel}"
STATE_DIR="${MANUEL_HEALTH_STATE_DIR:-/var/lib/manuel-health}"
STATUS_FILE="${MANUEL_HEALTH_STATUS:-$STATE_DIR/last.status}"
HEAL_DIR="$STATE_DIR/heal"
LOG_TAG="manuel-health"
# egress graba las llamadas; sin él el panel se queda sin audios.
LIVEKIT_SERVICES="${MANUEL_LIVEKIT_SERVICES:-livekit sip redis egress}"
LIVEKIT_CONTAINERS="${MANUEL_LIVEKIT_CONTAINERS:-livekit-manuel-livekit-1 livekit-manuel-sip-1 livekit-manuel-redis-1 livekit-manuel-egress-1}"
# Destino alerta: LID del +34 646 424 563 (el envío al número E.164 suele dar ERROR).
ALERT_TO="${MANUEL_HEALTH_ALERT_TO:-209169302954031@lid}"

AUTOHEAL="${MANUEL_HEALTH_AUTOHEAL:-1}"
HEAL_MAX="${MANUEL_HEAL_MAX_ATTEMPTS:-3}"       # intentos por acción y ventana
HEAL_WINDOW="${MANUEL_HEAL_WINDOW_SEC:-21600}"  # 6 h
HEAL_SETTLE="${MANUEL_HEAL_SETTLE_SEC:-20}"     # espera antes de re-verificar
[[ "${1:-}" == "--no-heal" ]] && AUTOHEAL=0

FAILS=0
MSGS=()
CODES=()
DID=()        # acciones ejecutadas (texto legible)
SKIPPED=()    # acciones bloqueadas por límite de intentos
EXHAUSTED=0   # 1 si alguna acción agotó su cupo en esta pasada
EVO_BASE=""
EVO_KEY=""
EVO_INST="bazan-951"

ok()  { MSGS+=("OK  $*"); }
bad() { # bad <code> <mensaje>
  local code="$1"; shift
  MSGS+=("FAIL $*")
  CODES+=("$code")
  FAILS=$((FAILS + 1))
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { bad "missing_cmd" "comando faltante: $1"; return 1; }
}

check_unit() { # check_unit <unit> <code>
  local u="$1" code="$2"
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    ok "systemd $u"
  else
    local st
    st=$(systemctl is-active "$u" 2>/dev/null | head -1)
    bad "$code" "systemd $u → ${st:-unknown}"
  fi
}

check_venv() {
  local py="$ROOT/voice-agent/.venv/bin/python"
  if [[ ! -x "$py" ]]; then
    bad "venv" "voice-agent/.venv ausente o roto ($py)"
    return
  fi
  if ! "$py" -c "import dotenv, livekit.agents" 2>/dev/null; then
    bad "venv" "voice-agent/.venv imports rotos (dotenv/livekit)"
    return
  fi
  ok "voice-agent/.venv"
}

load_evolution_env() {
  local envf="$ROOT/.env"
  [[ -f "$envf" ]] || return 1
  EVO_BASE=$(grep -E '^EVOLUTION_BASE_URL=' "$envf" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
  EVO_KEY=$(grep -E '^EVOLUTION_API_KEY=' "$envf" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
  EVO_INST=$(grep -E '^EVOLUTION_INSTANCE=' "$envf" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
  EVO_INST=${EVO_INST:-bazan-951}
  [[ -n "$EVO_BASE" && -n "$EVO_KEY" ]]
}

check_evolution() {
  if [[ ! -f "$ROOT/.env" ]]; then
    bad "env" ".env no encontrado"
    return
  fi
  if ! load_evolution_env; then
    bad "env" "Evolution env incompleta"
    return
  fi
  # Evolution está detrás de un proxy externo: un timeout suelto no es una avería.
  # Solo se declara caída tras varios intentos espaciados.
  local json="" attempt
  for attempt in 1 2 3; do
    json=$(curl -fsS -m 10 -H "apikey: $EVO_KEY" "$EVO_BASE/instance/connectionState/$EVO_INST" 2>/dev/null) && break
    json=""
    (( attempt < 3 )) && sleep 5
  done
  if [[ -z "$json" ]]; then
    bad "evolution" "Evolution API no alcanzable (3 intentos)"
    return
  fi
  local state
  state=$(printf '%s' "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('instance') or {}).get('state') or d.get('state') or '')" 2>/dev/null || true)
  if [[ "$state" == "open" ]]; then
    ok "Evolution $EVO_INST open"
  else
    bad "evolution" "Evolution $EVO_INST state=${state:-unknown} (requiere revincular QR a mano)"
  fi
}

check_docker() {
  need_cmd docker || return
  local c
  for c in $LIVEKIT_CONTAINERS; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      ok "docker $c"
    else
      bad "docker" "docker $c no está Up"
    fi
  done
}

run_checks() {
  FAILS=0
  MSGS=()
  CODES=()

  need_cmd curl
  need_cmd systemctl

  check_unit whatsapp-chatbot-951 unit_app
  check_unit manuel-voice-agent unit_voice

  if curl -fsS -m 3 "http://127.0.0.1:8081/" 2>/dev/null | grep -q "OK"; then
    ok "voz worker :8081"
  else
    bad "http_voice" "voz worker :8081 no responde"
  fi

  # App Node: cualquier HTTP 2xx/3xx/4xx = proceso vivo (la raíz puede ser 404).
  local code
  code=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3002/" 2>/dev/null || echo 000)
  if [[ "$code" =~ ^(2|3|4)[0-9][0-9]$ ]]; then
    ok "app :3002 (HTTP $code)"
  else
    bad "http_app" "app :3002 no responde (HTTP $code)"
  fi

  check_venv
  check_evolution
  check_docker
}

# ---------- auto-heal ----------

# Cupo de intentos por acción y ventana; evita bucles de reinicio.
heal_allowed() { # heal_allowed <accion>
  local action="$1"
  local f="$HEAL_DIR/$action"
  local now last count
  now=$(date +%s)
  last=0; count=0
  if [[ -f "$f" ]]; then
    read -r last count <"$f" 2>/dev/null || true
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    if (( now - last > HEAL_WINDOW )); then count=0; fi
  fi
  if (( count >= HEAL_MAX )); then
    SKIPPED+=("$action (cupo agotado: $count intentos en las últimas $((HEAL_WINDOW / 3600)) h)")
    return 1
  fi
  count=$((count + 1))
  echo "$now $count" >"$f"
  if (( count >= HEAL_MAX )); then EXHAUSTED=1; fi
  return 0
}

restart_unit() { # restart_unit <unit>
  logger -t "$LOG_TAG" "auto-heal: systemctl restart $1"
  if systemctl restart "$1" 2>/dev/null; then
    DID+=("reinicio $1")
  else
    DID+=("reinicio $1 (FALLÓ el restart)")
  fi
}

rebuild_venv() {
  local dir="$ROOT/voice-agent" py
  py=$(command -v python3.12 || command -v python3) || { DID+=("recrear .venv (sin python3)"); return; }
  logger -t "$LOG_TAG" "auto-heal: recreando voice-agent/.venv con $py"
  rm -rf "$dir/.venv.new" "$dir/.venv.old"
  if timeout 900 "$py" -m venv "$dir/.venv.new" >/dev/null 2>&1 &&
     timeout 900 "$dir/.venv.new/bin/pip" install -q -r "$dir/requirements.txt" >/dev/null 2>&1; then
    [[ -d "$dir/.venv" ]] && mv "$dir/.venv" "$dir/.venv.old"
    mv "$dir/.venv.new" "$dir/.venv"
    rm -rf "$dir/.venv.old"
    DID+=("recreado voice-agent/.venv + deps")
  else
    rm -rf "$dir/.venv.new"
    DID+=("recrear voice-agent/.venv (FALLÓ, .venv anterior intacto)")
  fi
}

docker_up() {
  # Solo los servicios de la lista: un `up -d` pelado levantaría cualquier cosa
  # que alguien haya dejado suelta en el compose.
  logger -t "$LOG_TAG" "auto-heal: docker compose up -d $LIVEKIT_SERVICES en $LIVEKIT_DIR"
  if [[ -d "$LIVEKIT_DIR" ]] && (cd "$LIVEKIT_DIR" && timeout 300 docker compose up -d $LIVEKIT_SERVICES >/dev/null 2>&1); then
    DID+=("docker compose up -d $LIVEKIT_SERVICES")
    return
  fi
  local c started=""
  for c in $LIVEKIT_CONTAINERS; do
    docker start "$c" >/dev/null 2>&1 && started+="$c "
  done
  DID+=("docker start: ${started:-ninguno}")
}

# Traduce códigos de fallo a acciones seguras (lista cerrada). Sin entrada para
# evolution/env/missing_cmd: esos solo se avisan.
plan_actions() {
  local c want_venv=0 want_voice=0 want_app=0 want_docker=0
  for c in ${CODES[@]+"${CODES[@]}"}; do
    case "$c" in
      venv)                want_venv=1; want_voice=1 ;;
      unit_voice|http_voice) want_voice=1 ;;
      unit_app|http_app)   want_app=1 ;;
      docker)              want_docker=1 ;;
    esac
  done
  local actions=()
  (( want_venv ))   && actions+=("rebuild_venv")
  (( want_voice ))  && actions+=("restart_voice")
  (( want_app ))    && actions+=("restart_app")
  (( want_docker )) && actions+=("docker_up")
  (( ${#actions[@]} > 0 )) && printf '%s\n' "${actions[@]}"
  return 0
}

run_action() {
  case "$1" in
    rebuild_venv)  rebuild_venv ;;
    restart_voice) restart_unit manuel-voice-agent ;;
    restart_app)   restart_unit whatsapp-chatbot-951 ;;
    docker_up)     docker_up ;;
  esac
}

# WhatsApp vía Evolution. Destino por defecto = LID del 646.
send_wa_alert() {
  local text="$1"
  if [[ -z "$EVO_KEY" || -z "$EVO_BASE" ]]; then load_evolution_env || true; fi
  if [[ -z "$EVO_BASE" || -z "$EVO_KEY" || -z "$ALERT_TO" ]]; then
    logger -t "$LOG_TAG" "No se pudo avisar por WA (falta Evolution o ALERT_TO)"
    return 1
  fi
  local payload
  payload=$(ALERT_TO="$ALERT_TO" TEXT="$text" python3 -c '
import json,os
print(json.dumps({"number": os.environ["ALERT_TO"], "text": os.environ["TEXT"][:1200]}))
')
  if curl -fsS -m 15 -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    -d "$payload" "$EVO_BASE/message/sendText/$EVO_INST" >/dev/null 2>&1; then
    logger -t "$LOG_TAG" "Alerta WA enviada a $ALERT_TO"
    return 0
  fi
  logger -t "$LOG_TAG" "Fallo enviando alerta WA a $ALERT_TO"
  return 1
}

join_lines() { (( $# > 0 )) && printf '%s\n' "$@"; return 0; }

# ---------- ejecución ----------

mkdir -p "$STATE_DIR" "$HEAL_DIR" 2>/dev/null || true

run_checks
FIRST_SUMMARY=$(join_lines ${MSGS[@]+"${MSGS[@]}"})
FIRST_FAILS=$FAILS

PREV=""
[[ -f "$STATUS_FILE" ]] && PREV=$(cat "$STATUS_FILE" 2>/dev/null || true)

HEALED=0
if (( FAILS > 0 )) && [[ "$AUTOHEAL" == "1" ]]; then
  mapfile -t PLAN < <(plan_actions)
  if (( ${#PLAN[@]} > 0 )); then
    logger -t "$LOG_TAG" "FAIL x$FAILS — auto-heal: ${PLAN[*]}"
    for a in "${PLAN[@]}"; do
      heal_allowed "$a" && run_action "$a"
    done
    if (( ${#DID[@]} > 0 )); then
      sleep "$HEAL_SETTLE"
      run_checks
      (( FAILS == 0 )) && HEALED=1
    fi
  fi
fi

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SUMMARY=$(join_lines ${MSGS[@]+"${MSGS[@]}"})
join_semi() { local out="" x; for x in "$@"; do out+="${out:+; }$x"; done; echo "$out"; }
ACTIONS_TXT=""
(( ${#DID[@]} > 0 ))     && ACTIONS_TXT="Acciones: $(join_semi "${DID[@]}")"
(( ${#SKIPPED[@]} > 0 )) && ACTIONS_TXT+=$'\n'"No reintentado: $(join_semi "${SKIPPED[@]}")"

printf '%s\n' "$SUMMARY"
[[ -n "$ACTIONS_TXT" ]] && printf '%s\n' "$ACTIONS_TXT"

if (( FAILS == 0 )); then
  echo "OK $TS" >"$STATUS_FILE"
  if (( HEALED )); then
    logger -t "$LOG_TAG" "HEALED | $ACTIONS_TXT"
    echo "RESULT=HEALED ($TS)"
    send_wa_alert "🔧 Manuel: fallo detectado y reparado solo

Fallaba:
$(printf '%s\n' "$FIRST_SUMMARY" | grep '^FAIL' || echo '(sin detalle)')

$ACTIONS_TXT

Ahora todo OK ($TS). No hace falta que hagas nada."
    exit 0
  fi
  logger -t "$LOG_TAG" "OK | ${MSGS[*]}"
  echo "RESULT=OK ($TS)"
  exit 0
fi

echo "FAIL $TS" >"$STATUS_FILE"
logger -t "$LOG_TAG" "FAIL x$FAILS | ${MSGS[*]} | $ACTIONS_TXT"
echo "RESULT=FAIL count=$FAILS ($TS)"

# Aviso al pasar de OK→FAIL, o cuando una acción agota su cupo de reintentos
# (así no spamea cada hora si sigue roto, pero sí avisa si se rinde).
if [[ "$PREV" == OK* ]] || (( EXHAUSTED )); then
  logger -t "$LOG_TAG" "ALERT → avisar WA (prev=${PREV:-none} exhausted=$EXHAUSTED)"
  send_wa_alert "⚠️ Manuel (951/614) HEALTH FAIL

$SUMMARY

${ACTIONS_TXT:-Sin auto-reparación aplicable.}

$TS
Requiere revisión manual (VPS / Evolution / voz)."
fi

exit 1
