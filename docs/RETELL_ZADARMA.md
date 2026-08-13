# Retell AI + Zadarma 951 + VPS (Roberto)

Guía para usar **Retell** (voz, STT/TTS) con el **+34 951 870 058** de Zadarma y el cerebro de negocio en tu VPS (`whatsapp-chatbot`): fichas reales, leads por WhatsApp a Miguel/Álvaro, histórico de llamadas.

**No necesitas LiveKit ni OpenAI Realtime.** Retell gestiona la voz; el VPS gestiona los datos.

```
Cliente → Zadarma 951 → Retell (voz + LLM) → custom functions → VPS /voice/retell/function
                                                              → leads WhatsApp (Evolution)
Retell call_ended → POST /webhook/retell → voice_calls (transcripción)
```

---

## 1. VPS — variables `.env`

En el servidor (`187.124.47.44`):

```bash
VOICE_ROBERTO_ENABLED=1
VOICE_ROBERTO_ALWAYS_ON=1
VOICE_API_KEY=<genera con: openssl rand -hex 32>
RETELL_ENABLED=1
VOICE_LEAD_EMAIL_ENABLED=1
EMAIL_ENABLED=1
EMAIL_USER=...
EMAIL_PASS=...
# Emails de comerciales (derivar_comercial)
VOICE_BUYER_AGENT_EMAIL=miguel@inmobiliariabazan.com
VOICE_OWNER_AGENT_EMAIL=alvaro@inmobiliariabazan.com
# Si envías a otros @inmobiliariabazan.com, añádelos a EMAIL_OUTBOUND_ALLOWLIST

VOICE_BUYER_AGENT_NAME=Miguel
VOICE_BUYER_AGENT_PHONE=34620555989
VOICE_OWNER_AGENT_NAME=Álvaro
VOICE_OWNER_AGENT_PHONE=34646424563

EVOLUTION_INSTANCE=chatbot
```

Despliega:

```bash
git pull && npm install && npm run build
sudo systemctl restart whatsapp-chatbot
```

Comprueba:

```bash
curl -s http://187.124.47.44:3001/voice/roberto/instructions \
  -H "X-Voice-Api-Key: TU_CLAVE" | head -c 300
```

---

## 2. Retell — crear agente Roberto

1. [app.retellai.com](https://app.retellai.com) → **Agents** → **Create agent**.
2. Tipo: **Single prompt**.
3. **Begin message:** `Hola, soy Roberto de Inmobiliaria Bazán. Dígame.`
4. **Prompt:** copia el campo `instructions` de `GET /voice/roberto/instructions` (con tu `VOICE_API_KEY`).
5. **Voz:** español (España). Prueba hasta que suene castiza.
6. En el prompt: *"Si el cliente habla inglés, responde en inglés."*

---

## 3. Retell — custom functions (VPS)

En el agente → **Custom functions**. En **todas** añade header `X-Voice-Api-Key: TU_VOICE_API_KEY`.

**URL (POST):** `http://187.124.47.44:3001/voice/retell/function`

### `buscar_propiedad`

Parámetros: `ref`, `transaction_type`, `property_type`, `location_contains`, `max_price`, `min_bedrooms`.

En el prompt: *"Nunca inventes precios; llama siempre a buscar_propiedad."*

### `derivar_comercial`

Parámetros requeridos: `intent` (`comprar|alquilar|vender|alquiler_propietario|traspaso|visita`), opcionales: `name`, `phone`, `email`, `ref`, `summary`.

Avisa al comercial por **WhatsApp** y por **email** (mismo formato que los leads de portal). Si el cliente dio `email`, recibe confirmación automática con la ficha si hay `ref`.

Requiere `EMAIL_ENABLED=1` y `VOICE_LEAD_EMAIL_ENABLED=1` en el VPS.

### `enviar_whatsapp_cliente`

Parámetros: `ref` y/o `text`.

### `enviar_email_cliente`

Parámetros requeridos: `email`. Opcionales: `name`, `ref`, `text`, `intent`.

Envía al cliente la ficha o un texto por correo (útil si no tiene WhatsApp o prefiere email).

---

## 4. Zadarma → Retell (SIP)

Guía Zadarma: [retellai](https://zadarma.com/en/support/instructions/retellai/)

### Retell

1. **Phone Numbers** → **Connect via SIP trunking**.
2. Número: `+34951870058`.
3. Asigna el agente Roberto (inbound).

### Zadarma (Servidor externo)

En **Call forwarding → Always → External server (SIP URI)**:

```text
+34951870058@sip.retellai.com
```

Guarda. **No uses LiveKit** si vas con Retell.

---

## 5. Webhook Retell (histórico)

Agente → **Webhook URL:** `http://187.124.47.44:3001/webhook/retell`  
Eventos: `call_started`, `call_ended`.

Revisa llamadas: `GET /admin/voice/calls` con `x-admin-key`.

---

## 6. Prueba

Llama al 951 → saludo Roberto → pide alquiler en Málaga → debe buscar ficha real → derivar comercial si pide visita.

---

## Costes

| Servicio | ¿Lo usas? |
|----------|-----------|
| Retell | Sí (tu plan actual) |
| OpenAI Realtime | No |
| LiveKit | No |
| VPS + Zadarma | Ya los tienes |
