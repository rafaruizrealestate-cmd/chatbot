# whatsapp-chatbot-951 — Lara

Asistente IA de **Inmobiliaria Bazán** para el **+34 951 870 058** (WhatsApp + voz).

Proyecto **independiente** de [whatsapp-chatbot](../whatsapp-chatbot) (Leo, 672). Leo no se modifica.

## Diferencias con Leo

| | Leo (672) | Lara (951) |
|---|---|---|
| Puerto VPS | 3001 | **3002** |
| Aviso leads a comerciales | WhatsApp | **Solo email** |
| Bandeja IMAP (portales) | Activa | **Desactivada** (`EMAIL_ENABLED=0`) |
| Catálogo inmuebles | Scrape propio | **Compartido** con Leo (`PROPERTIES_DATABASE_PATH`) |
| Voz | — | LiveKit como **Lara** |

## Arranque local

```bash
cp .env.example .env
# Rellenar EVOLUTION_*, OPENAI_API_KEY, EMAIL_PASS (SMTP), etc.
npm ci
npm run dev
```

Health: `http://localhost:3002/health`

## VPS

- Ruta: `/opt/whatsapp-chatbot-951`
- Servicio: `whatsapp-chatbot-951.service` (ver `deploy/`)
- Webhook Evolution: apuntar la instancia del 951 a `http://187.124.47.44:3002/webhook`
- Retell custom functions: `http://187.124.47.44:3002/voice/retell/function`
- Instrucciones voz: `GET /voice/lara/instructions` (alias `/voice/manuel/instructions`)

## Panel web

Interfaz con usuario y contraseña para ver todo lo que recibe y hace la IA: llamadas con su
grabación y transcripción, conversaciones de WhatsApp, leads y cada herramienta que ejecuta
(con el tiempo que tardó).

- Producción: <https://panel-manuel.crbr5h.easypanel.host/panel/>
- Local: `http://localhost:3002/panel/`
- Roles: `admin` (gestiona usuarios) y `viewer` (solo lectura).

```bash
npm run panel:user -- list
npm run panel:user -- create secretaria --role viewer   # genera contraseña
npm run panel:user -- password alvaro                   # cierra sus sesiones
```

Las grabaciones se activan en `voice-agent/.env` (`VOICE_RECORDING_ENABLED=1`) y necesitan el
contenedor `egress` de LiveKit levantado. Se purgan con el resto del histórico según
`VOICE_RETENTION_DAYS`.

## Variables clave

- `AGENT_NOTIFY_CHANNEL=email` — comerciales solo por email
- `PROPERTIES_DATABASE_PATH=/opt/whatsapp-chatbot/data/chatbot.db` — mismo scrape que Leo
- `EMAIL_ENABLED=0` — no procesa portales; activar cuando toque
- `WHATSAPP_PROACTIVE_OUTREACH=0` — solo responde a quien escriba; sin WhatsApp a desconocidos
- `VOICE_LEAD_EMAIL_ENABLED=1` — confirmaciones y leads de llamada por SMTP

Documentación voz: [docs/RETELL_ZADARMA.md](./docs/RETELL_ZADARMA.md)
