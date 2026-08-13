# Voice Agent — Roberto (LiveKit + OpenAI Realtime)

Worker que atiende las llamadas del +34 951 870 058 (Zadarma → LiveKit SIP) con la voz de
**Roberto**, recepcionista de Inmobiliaria Bazán. Usa el backend `whatsapp-chatbot` (VPS) para
fichas, leads y archivo de llamadas, de modo que la lógica comercial es la misma que en WhatsApp.

## Arquitectura

```
Cliente → Zadarma 951 → LiveKit SIP → este worker
   ↕ audio (OpenAI Realtime, voz es-ES)
   → tools HTTP → VPS /voice/tools/*  (buscar_propiedad, derivar_comercial, enviar_whatsapp)
   → turnos    → VPS /voice/sessions/:id/turn
```

## Requisitos

- Python 3.12
- Cuenta LiveKit (Cloud o self-hosted) con **SIP** habilitado
- `OPENAI_API_KEY` con acceso a Realtime API
- Backend `whatsapp-chatbot` con `VOICE_ROBERTO_ENABLED=1` y `VOICE_API_KEY`

## Instalación

```bash
cd voice-agent
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # rellena las claves
python agent.py download-files
```

## Ejecutar

```bash
# Desarrollo (consola)
python agent.py console

# Conectado a LiveKit (producción)
python agent.py start
```

## Docker

```bash
docker build -t bazan-voice-agent .
docker run --env-file .env bazan-voice-agent
```

## Conexión SIP con Zadarma

1. En LiveKit crea un **SIP inbound trunk** y una **dispatch rule** que envíe las llamadas a una room.
2. En Zadarma, enruta el 951 al **servidor SIP externo** de LiveKit (URI del trunk), 24/7.
3. Las llamadas entrantes disparan `entrypoint()` y arranca Roberto.

## Voz española

`OPENAI_REALTIME_VOICE=marin` suele sonar neutro; prueba también `cedar` o `alloy`. Las
instrucciones (servidas por el VPS en `/voice/roberto/instructions`) fuerzan español de España y
cambio a inglés si el cliente habla en inglés.

## Notas

- Las instrucciones y el saludo se cargan del VPS en cada llamada (versionadas), así puedes
  ajustar el prompt sin redeployar el worker.
- La transcripción se guarda por turnos en el VPS (`voice_call_turns`); revísala en
  `GET /admin/voice/calls`.
