# Zadarma +34 951 870 058 — voz con Leo (no WhatsApp)

El número **+34 951 870 058** es un **número virtual de voz** en Zadarma. **No** es un móvil con chip: no se puede emparejar con Evolution API por QR ni por código de vinculación.

| Canal | Número | Cómo funciona |
|-------|--------|----------------|
| **WhatsApp** (texto) | +34 672 594 724 | Evolution API + QR en el móvil Digi |
| **Voz IA** | +34 951 870 058 | Zadarma → SIP → LiveKit → API Leo en este servidor |

Las credenciales que da Zadarma (SIP, PBX) sirven para **llamadas de voz**, no para registrar WhatsApp en el 951.

## Arquitectura

```
Cliente llama al 951
    → Zadarma PBX
    → (fuera de horario) Servidor externo SIP → LiveKit
    → Agente de voz transcribe / sintetiza
    → POST https://TU-DOMINIO/voice/leo/reply  (mismo cerebro que WhatsApp)
    → Respuesta de Leo → TTS → el cliente escucha
```

En paralelo, Zadarma puede notificar eventos de llamada a:

`GET/POST https://TU-DOMINIO/webhook/zadarma`

## 1. Variables en el VPS (`.env`)

```bash
ZADARMA_ENABLED=1
ZADARMA_API_SECRET=<API Secret de Zadarma>
ZADARMA_TRACKED_NUMBERS=34951870058
VOICE_API_KEY=<clave larga aleatoria>
```

Opcional en desarrollo:

```bash
ZADARMA_SKIP_SIGNATURE_VERIFY=1
```

Reinicia el servicio tras cambiar `.env`:

```bash
sudo systemctl restart whatsapp-chatbot
```

## 2. Webhook en Zadarma

1. [my.zadarma.com](https://my.zadarma.com) → **Ajustes** → **Integraciones** → **Webhooks PBX**.
2. URL: `https://TU-DOMINIO/webhook/zadarma`
3. Zadarma enviará `GET ?zd_echo=...` para verificar; el servidor responde con el mismo valor.
4. Activa notificaciones **NOTIFY_START**, **NOTIFY_END**, **NOTIFY_ANSWER** (como mínimo START y END).

Firma: HMAC-SHA1 en base64 de `caller_id + called_did + call_start` con tu **API Secret**.

## 3. Enrutamiento del 951 en Zadarma

- **Fuera de horario laboral** (L–V 10:00–19:30 Europe/Madrid): enruta a **servidor SIP externo** (LiveKit), por ejemplo:
  - `+34951870058@5t4n6j0wnrl.sip.livekit.cloud`
- **En horario de oficina**: enruta a humanos / cola / buzón (no a la IA). El webhook solo registra el evento; la ruta la defines en el panel Zadarma.

## 4. API Leo para LiveKit

El agente de voz en LiveKit debe llamar a este endpoint con la transcripción del usuario:

```http
POST /voice/leo/reply
Content-Type: application/json
X-Voice-Api-Key: <VOICE_API_KEY>

{
  "from": "34600111222",
  "text": "Busco un piso de alquiler en Málaga centro",
  "displayFrom": "+34600111222"
}
```

Respuesta:

```json
{ "reply": "Perfecto, ¿qué presupuesto mensual tienes en mente?" }
```

Usa el mismo `processIncomingText` que WhatsApp: leads, fichas, derivación a comerciales, etc.

## 5. WhatsApp en el 951

Si en el futuro quisieras **WhatsApp en el 951**, haría falta **Meta WhatsApp Cloud API** (o Business API) con ese número verificado en Meta — es un flujo distinto al SIP de Zadarma. Hoy el WhatsApp del chatbot sigue siendo el **672** vía Evolution.

## Código

| Archivo | Rol |
|---------|-----|
| `src/voice/zadarmaWebhook.ts` | GET/POST `/webhook/zadarma` |
| `src/voice/voiceLeoApi.ts` | POST `/voice/leo/reply` |
| `src/voice/voiceLeo.ts` | Cerebro Leo compartido para voz |
| `src/voice/zadarmaAuth.ts` | Verificación HMAC |

## Comprobar

```bash
curl -s https://TU-DOMINIO/health

# Verificación Zadarma (simular echo)
curl -s "https://TU-DOMINIO/webhook/zadarma?zd_echo=test123"

# Leo (sustituye clave y dominio)
curl -s -X POST https://TU-DOMINIO/voice/leo/reply \
  -H "Content-Type: application/json" \
  -H "X-Voice-Api-Key: TU_CLAVE" \
  -d '{"from":"34600000000","text":"Hola"}'
```
