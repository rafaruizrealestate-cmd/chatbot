#!/usr/bin/env bash
# Investigación llamadas perdidas — pegar en VPS: bash scripts/investigar-llamada-perdida.sh [teléfono]
set -euo pipefail
cd /opt/whatsapp-chatbot
DB="./data/chatbot.db"
PHONE="${1:-}"

echo "=== Emails clasificados como llamada perdida (últimos 14 días) ==="
sqlite3 -header -column "$DB" "
SELECT uid,
       datetime(processed_at) AS processed_at,
       portal,
       handled,
       COALESCE(suppress_reason,'') AS reason,
       substr(subject_snippet,1,80) AS subject,
       customer_phone,
       customer_email,
       property_ref
FROM email_state
WHERE processed_at >= datetime('now', '-14 days')
  AND (
    lower(subject_snippet) LIKE '%llamada%'
    OR lower(body_snippet) LIKE '%llamada no contestada%'
    OR lower(body_snippet) LIKE '%llamada perdida%'
    OR lower(subject_snippet) LIKE '%no contestada%'
  )
ORDER BY processed_at DESC;
"

echo ""
echo "=== Perfiles missed_call_pending (lead_profiles) ==="
sqlite3 -header -column "$DB" "
SELECT customer_phone, name, ref, intent_type, extra_notes, datetime(updated_at) AS updated
FROM lead_profiles
WHERE extra_notes LIKE '%missed_call_pending%'
ORDER BY updated_at DESC;
"

echo ""
echo "=== Leads con texto de llamada (histórico / sospechosos) ==="
sqlite3 -header -column "$DB" "
SELECT datetime(created_at) AS at, origin, intent, ref, agent_name, customer_phone,
       substr(summary,1,150) AS summary
FROM lead_notifications
WHERE created_at >= datetime('now', '-14 days')
  AND (lower(summary) LIKE '%llamada%' OR ref = '582065')
ORDER BY created_at DESC;
"

if [[ -n "$PHONE" ]]; then
  echo ""
  echo "=== Conversación WhatsApp tel $PHONE ==="
  sqlite3 -header -column "$DB" "
  SELECT datetime(timestamp) AS at, role, length(content) AS chars,
         substr(content,1,300) AS content
  FROM conversations
  WHERE phone_number = '$PHONE'
  ORDER BY timestamp;
  "
fi

echo ""
echo "=== FIN investigación ==="
