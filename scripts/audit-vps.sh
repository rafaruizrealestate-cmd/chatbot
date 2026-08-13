#!/usr/bin/env bash
# Auditoría operativa del bot en el VPS (SQLite). Uso: HOURS=350 ./scripts/audit-vps.sh
set -euo pipefail

HOURS="${HOURS:-350}"
ROOT="${ROOT:-/opt/whatsapp-chatbot}"
DB="${DB:-$ROOT/data/chatbot.db}"

cd "$ROOT"
echo "=== VPS audit (últimas ${HOURS}h) ==="
echo "commit: $(git log -1 --oneline 2>/dev/null || echo unknown)"
echo "db: $DB"
echo

run() {
  echo "--- $1 ---"
  shift
  sqlite3 -header -column "$DB" "$@"
  echo
}

run_json() {
  echo "--- $1 ---"
  shift
  sqlite3 -json "$DB" "$@"
  echo
}

run_json "Rango temporal" "
SELECT datetime('now') AS now_utc,
       datetime('now', '-${HOURS} hours') AS since_utc;
"

run_json "Conversaciones por rol" "
SELECT role, COUNT(*) AS n
FROM conversations
WHERE timestamp >= datetime('now', '-${HOURS} hours')
GROUP BY role;
"

run_json "Emails por portal y handled" "
SELECT portal, handled, COUNT(*) AS n
FROM email_state
WHERE processed_at >= datetime('now', '-${HOURS} hours')
GROUP BY portal, handled
ORDER BY portal, handled;
"

run_json "Leads por origin e intent" "
SELECT COALESCE(origin, '(sin origin)') AS origin, intent, COUNT(*) AS n
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours')
GROUP BY origin, intent
ORDER BY n DESC;
"

run "Leads sospechosos (llamada perdida / 582065 / col.idealista)" "
SELECT datetime(created_at) AS at,
       COALESCE(origin, '') AS origin,
       intent, ref, agent_name,
       substr(summary, 1, 100) AS summary_head
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours')
  AND (
    lower(summary) LIKE '%llamada no contestada%'
    OR ref = '582065'
    OR lower(summary) LIKE '%col.idealista.com%'
  )
ORDER BY created_at DESC;
"

run "Leads sospechosos últimas 48h" "
SELECT datetime(created_at) AS at,
       COALESCE(origin, '') AS origin,
       intent, ref
FROM lead_notifications
WHERE created_at >= datetime('now', '-48 hours')
  AND (
    lower(summary) LIKE '%llamada no contestada%'
    OR ref = '582065'
  )
ORDER BY created_at DESC;
"

run "Intención vs transaction_type (mismatch)" "
SELECT datetime(l.created_at) AS at,
       COALESCE(l.origin, '') AS origin,
       l.intent, l.ref, p.transaction_type, l.agent_name
FROM lead_notifications l
LEFT JOIN properties p ON p.ref = l.ref
WHERE l.created_at >= datetime('now', '-${HOURS} hours')
  AND l.ref IS NOT NULL
  AND p.transaction_type IS NOT NULL
  AND (
    (lower(p.transaction_type) LIKE '%alquiler%' AND l.intent <> 'A')
    OR (lower(p.transaction_type) LIKE '%venta%' AND l.intent <> 'B')
  )
ORDER BY l.created_at DESC;
"

run "Emails handled=0 (últimos 80)" "
SELECT uid,
       datetime(processed_at) AS at,
       portal,
       handled,
       COALESCE(suppress_reason, '(sin reason)') AS reason,
       substr(subject_snippet, 1, 70) AS subj,
       substr(from_address, 1, 45) AS from_addr,
       substr(customer_phone, 1, 18) AS phone
FROM email_state
WHERE processed_at >= datetime('now', '-${HOURS} hours')
  AND handled = 0
ORDER BY processed_at DESC
LIMIT 80;
"

run "Emails portal con contacto pero handled=0" "
SELECT uid,
       datetime(processed_at) AS at,
       portal,
       suppress_reason,
       substr(subject_snippet, 1, 70) AS subj,
       customer_phone,
       customer_email
FROM email_state
WHERE processed_at >= datetime('now', '-${HOURS} hours')
  AND handled = 0
  AND portal IN ('idealista', 'fotocasa', 'habitatsoft')
  AND (customer_phone IS NOT NULL OR customer_email IS NOT NULL)
ORDER BY processed_at DESC;
"

echo "--- Fallback Bazán-only (conteos) ---"
sqlite3 "$DB" "
SELECT 'total_${HOURS}h' AS bucket, COUNT(*) AS n
FROM conversations
WHERE timestamp >= datetime('now', '-${HOURS} hours')
  AND role = 'assistant'
  AND content LIKE 'Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.%'
UNION ALL
SELECT 'last_48h', COUNT(*)
FROM conversations
WHERE timestamp >= datetime('now', '-48 hours')
  AND role = 'assistant'
  AND content LIKE 'Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.%';
"
echo

run "Ejemplos fallback últimas 48h" "
SELECT datetime(timestamp) AS at,
       phone_number,
       substr(content, 1, 90) AS head
FROM conversations
WHERE timestamp >= datetime('now', '-48 hours')
  AND role = 'assistant'
  AND content LIKE 'Solo puedo recomendar opciones y contactos de Inmobiliaria Bazán.%'
ORDER BY timestamp DESC
LIMIT 20;
"

run_json "Calidad leads (agregado)" "
SELECT COUNT(*) AS total,
       SUM(CASE WHEN summary LIKE '%- Nombre: No indicado%' THEN 1 ELSE 0 END) AS sin_nombre,
       SUM(CASE WHEN summary LIKE '%- Referencia: No indicada%' THEN 1 ELSE 0 END) AS sin_ref,
       SUM(CASE WHEN summary LIKE '%Faltan datos:%' THEN 1 ELSE 0 END) AS con_faltan_datos,
       SUM(CASE WHEN origin IS NULL OR origin = '' THEN 1 ELSE 0 END) AS sin_procedencia
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours');
"

run "Últimos 25 leads — mensaje del cliente (cola del aviso)" "
SELECT datetime(created_at) AS at,
       COALESCE(origin, '') AS origin,
       ref,
       agent_name,
       CASE
         WHEN summary LIKE '%mensaje del cliente: %' THEN
           trim(substr(summary, instr(summary, 'mensaje del cliente: ') + length('mensaje del cliente: ')))
         ELSE '(sin campo)'
       END AS mensaje_cliente
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours')
ORDER BY created_at DESC
LIMIT 25;
"

run "Leads con mensaje del cliente sospechoso (72h)" "
SELECT datetime(created_at) AS at, origin, ref,
       substr(summary, instr(summary, 'mensaje del cliente: ')) AS tail
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours')
  AND (
    lower(summary) LIKE '%mensaje del cliente: he encontrado%'
    OR lower(summary) LIKE '%mensaje del cliente: tienes un nuevo%'
    OR lower(summary) LIKE '%mensaje del cliente: hoy me llamas%'
    OR lower(summary) LIKE '%mensaje del cliente: ver perfil%'
    OR lower(summary) LIKE '%mensaje del cliente: datos de la persona%'
    OR lower(summary) LIKE '%mensaje del cliente: llamada no contestada%'
    OR lower(summary) LIKE '%mensaje del cliente: col.idealista%'
  )
ORDER BY created_at DESC;
"

run "Últimos 25 leads" "
SELECT datetime(created_at) AS at,
       COALESCE(origin, '') AS origin,
       intent, ref, agent_name,
       substr(summary, 1, 110) AS summary_head
FROM lead_notifications
WHERE created_at >= datetime('now', '-${HOURS} hours')
ORDER BY created_at DESC
LIMIT 25;
"

run_json "WhatsApp pending sin procesar" "
SELECT COUNT(*) AS n_pending
FROM whatsapp_pending
WHERE processed_at IS NULL
  AND received_at >= datetime('now', '-${HOURS} hours');
"

run_json "Servicio (systemctl)" "
SELECT 'skip' AS note;
" 2>/dev/null || true

systemctl is-active whatsapp-chatbot.service 2>/dev/null && \
  systemctl show whatsapp-chatbot.service -p ActiveState -p SubState --value 2>/dev/null | paste - - || \
  echo "systemctl: no disponible"

echo "=== Fin auditoría ==="
