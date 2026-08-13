# Incidencia: llamada perdida Idealista (11 jun 2026)

Caso concreto de seguimiento operativo. Documento principal: [OPERATIVA_LEO.md](../../OPERATIVA_LEO.md).

## Resumen

- Email Idealista de llamada perdida recibido ~**20:09** (hora peninsular).
- WhatsApp de outreach registrado en BD **18:10 UTC** (**20:10** Madrid).
- Mensaje guardado en `conversations`.
- Email marcado como gestionado tras deploy y eliminación de lock huérfano.
- El cliente **no había respondido** por WhatsApp en el momento de la revisión → no existía lead al comercial (faltaban nombre + ref confirmados en chat).

## Comprobación en VPS

```bash
sqlite3 /opt/whatsapp-chatbot/data/chatbot.db \
  "SELECT datetime(timestamp), role, substr(content,1,120) FROM conversations WHERE phone_number='34641245807';"
```

## Contexto técnico

Este caso motivó revisar el flujo de persistencia en BD antes de marcar emails como leídos y la caducidad del lock del cron de email. Las reglas derivadas están recogidas en la §6 del documento operativo principal.
