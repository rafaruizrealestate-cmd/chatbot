"""Agente de voz Lucía (interno: lara) para Mambo Inmobiliaria.

LiveKit Agents + OpenAI Realtime API. Recibe llamadas SIP (Zadarma -> LiveKit),
usa el mismo backend que el WhatsApp-chatbot (VPS) para fichas, leads y archivo.
"""

import asyncio
import logging
import os
import re
import time

import httpx
from dotenv import load_dotenv

from livekit import api
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    function_tool,
)
from livekit.plugins import openai
from openai.types.beta.realtime.session import (
    InputAudioNoiseReduction,
    InputAudioTranscription,
    TurnDetection,
)

load_dotenv()

logger = logging.getLogger("lara")

VPS_BASE_URL = os.environ["VPS_BASE_URL"].rstrip("/")
VOICE_API_KEY = os.environ["VOICE_API_KEY"]
REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-1.5")
# Realtime NO admite "nova" (eso es TTS WhatsApp). Válidas: alloy, ash, ballad,
# coral, echo, sage, shimmer, verse, marin, cedar.
_REALTIME_VOICES = {
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
}
_raw_voice = (os.getenv("OPENAI_REALTIME_VOICE") or "cedar").strip().lower()
REALTIME_VOICE = _raw_voice if _raw_voice in _REALTIME_VOICES else "cedar"
# Velocidad de habla Realtime. 1.0 = natural; 1.1 un poco más vivo (preferencia producto).
try:
    REALTIME_SPEED = float(os.getenv("OPENAI_REALTIME_SPEED", "1.05"))
except ValueError:
    REALTIME_SPEED = 1.05
REALTIME_SPEED = max(0.75, min(1.5, REALTIME_SPEED))
MAX_CALL_MINUTES = int(os.getenv("VOICE_MAX_CALL_MINUTES", "15"))
RECORDING_ENABLED = os.getenv("VOICE_RECORDING_ENABLED", "0") == "1"
RECORDINGS_DIR = os.getenv(
    "VOICE_RECORDINGS_DIR", "/opt/whatsapp-chatbot-951/data/voice-recordings"
)
# Ruta DENTRO del contenedor egress (montaje host → /out).
EGRESS_OUTPUT_DIR = os.getenv("VOICE_EGRESS_OUTPUT_DIR", "/out").rstrip("/")
AGENT_NAME = os.getenv("LIVEKIT_AGENT_NAME", "lara")
AGENCY_NAME = (os.getenv("AGENCY_NAME") or "Mambo Inmobiliaria").strip() or "Mambo Inmobiliaria"
VOICE_BOT_NAME = (
    (os.getenv("VOICE_BOT_NAME") or os.getenv("BOT_NAME") or "Lucía").strip() or "Lucía"
)
# server_vad (teléfono) | semantic_vad
TURN_MODE = (os.getenv("OPENAI_REALTIME_TURN_MODE") or "server_vad").strip().lower()
TURN_EAGERNESS = os.getenv("OPENAI_REALTIME_EAGERNESS", "low").strip() or "low"
# 1 = barge-in (el cliente puede interrumpir). 0 = Manuel no cede el turno (preferencia producto / menos cortes por eco PSTN).
INTERRUPT_RESPONSE = os.getenv("OPENAI_REALTIME_INTERRUPT", "0").strip() == "1"
# Umbral VAD: más alto = menos sensibles a ruido/eco (0.0–1.0).
VAD_THRESHOLD = float(os.getenv("OPENAI_REALTIME_VAD_THRESHOLD", "0.88"))
# Con barge-in off: ~780 ms de silencio del cliente antes de que Manuel retome.
VAD_SILENCE_MS = int(os.getenv("OPENAI_REALTIME_VAD_SILENCE_MS", "780"))
VAD_PREFIX_MS = int(os.getenv("OPENAI_REALTIME_VAD_PREFIX_MS", "300"))
# near_field | far_field — far_field suele ir mejor en PSTN/Zadarma.
NOISE_REDUCTION = os.getenv("OPENAI_REALTIME_NOISE_REDUCTION", "far_field").strip() or "far_field"
TRANSCRIBE_MODEL = os.getenv("OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-4o-transcribe").strip() or "gpt-4o-transcribe"
# Saludo: siempre habla Manuel primero. Si hay locutor de portal, espera silencio y entonces saluda.
WELCOME_MAX_WAIT_S = float(os.getenv("VOICE_WELCOME_MAX_WAIT_S", "4.0"))
WELCOME_SILENCE_S = float(os.getenv("VOICE_WELCOME_SILENCE_S", "0.55"))
# Línea en silencio → saluda al momento (0 = sin espera extra).
WELCOME_QUIET_S = float(os.getenv("VOICE_WELCOME_QUIET_S", "0"))
PORTAL_ANNOUNCE_RE = (
    r"idealista|fotocasa|habitasoft|pisos\.?\s*com|llamada\s+de\s+"
    r"|le\s+paso\s+una\s+llamada|transferenc|anunciante"
)


def _build_turn_detection() -> TurnDetection:
    """Config de turnos pensada para teléfono (menos cortes falsos)."""
    if TURN_MODE == "semantic_vad":
        return TurnDetection(
            type="semantic_vad",
            eagerness=TURN_EAGERNESS,  # type: ignore[arg-type]
            create_response=True,
            interrupt_response=INTERRUPT_RESPONSE,
        )
    return TurnDetection(
        type="server_vad",
        threshold=VAD_THRESHOLD,
        prefix_padding_ms=VAD_PREFIX_MS,
        silence_duration_ms=VAD_SILENCE_MS,
        create_response=True,
        interrupt_response=INTERRUPT_RESPONSE,
    )

server = AgentServer()


async def _start_recording(room_name: str, call_id: str) -> tuple[str | None, str | None]:
    """Arranca un egress de audio de la room a un fichero local. Devuelve (egress_id, host_path)."""
    if not RECORDING_ENABLED:
        return None, None
    filename = f"{call_id or room_name}.ogg"
    egress_path = f"{EGRESS_OUTPUT_DIR}/{filename}"
    host_path = f"{RECORDINGS_DIR.rstrip('/')}/{filename}"
    lkapi = api.LiveKitAPI()
    try:
        req = api.RoomCompositeEgressRequest(
            room_name=room_name,
            audio_only=True,
            file_outputs=[api.EncodedFileOutput(filepath=egress_path)],
        )
        res = await lkapi.egress.start_room_composite_egress(req)
        return res.egress_id, host_path
    except Exception as e:  # noqa: BLE001
        logger.error("No se pudo iniciar la grabación: %s", e)
        return None, None
    finally:
        await lkapi.aclose()


async def _stop_recording(egress_id: str) -> None:
    if not egress_id:
        return
    lkapi = api.LiveKitAPI()
    try:
        await lkapi.egress.stop_egress(api.StopEgressRequest(egress_id=egress_id))
    except Exception as e:  # noqa: BLE001
        logger.warning("No se pudo detener la grabación: %s", e)
    finally:
        await lkapi.aclose()


def _headers() -> dict:
    return {"X-Voice-Api-Key": VOICE_API_KEY, "Content-Type": "application/json"}


async def _post(client: httpx.AsyncClient, path: str, payload: dict) -> dict:
    try:
        r = await client.post(
            f"{VPS_BASE_URL}{path}", json=payload, headers=_headers(), timeout=20
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        logger.error("POST %s falló: %s", path, e)
        return {"ok": False, "error": "backend_error"}


async def _get(client: httpx.AsyncClient, path: str) -> dict:
    try:
        r = await client.get(f"{VPS_BASE_URL}{path}", headers=_headers(), timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        logger.error("GET %s falló: %s", path, e)
        return {}


def _caller_from_participant(ctx: JobContext) -> str:
    """Extrae el número del llamante de los atributos SIP del participante."""
    for p in ctx.room.remote_participants.values():
        attrs = getattr(p, "attributes", {}) or {}
        num = attrs.get("sip.phoneNumber") or attrs.get("sip.from") or ""
        digits = "".join(ch for ch in num if ch.isdigit())
        if digits:
            return digits
    return ""


def _extract_item_text(item: object) -> str:
    """Texto de un ChatMessage, incluyendo transcript de AudioContent (turnos de usuario)."""
    parts: list[str] = []
    content = getattr(item, "content", None) or []
    for c in content:
        if isinstance(c, str):
            s = c.strip()
            if s:
                parts.append(s)
            continue
        tr = getattr(c, "transcript", None)
        if isinstance(tr, str) and tr.strip():
            parts.append(tr.strip())
    if parts:
        return "\n".join(parts)
    t = getattr(item, "text_content", None) or ""
    return (t or "").strip()


def _opt_float(v: float | str | None) -> float | None:
    """Realtime a veces manda '' en campos numéricos opcionales; no debe tumbar la tool."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip().replace(",", ".")
        if not s:
            return None
        try:
            return float(s)
        except ValueError:
            return None
    return float(v)


def _opt_int(v: int | float | str | None) -> int | None:
    f = _opt_float(v if not isinstance(v, int) else float(v))
    if f is None:
        return None
    return int(round(f))


class LaraAgent(Agent):
    def __init__(
        self,
        instructions: str,
        client: httpx.AsyncClient,
        caller: str,
        call_id: str,
        room_name: str = "",
    ):
        super().__init__(instructions=instructions)
        self._client = client
        self._caller = caller
        self._call_id = call_id
        self._room_name = room_name
        self._sip_identity = ""
        self._logged: set[str] = set()
        self._hangup_scheduled = False
        self._ended_posted = False
        # summary/intent de finalizar_llamada; el POST /end lo hace solo el shutdown.
        self._end_payload: dict = {}
        self._last_assistant_text = ""
        self._recent_user_texts: list[str] = []

    async def _log_turn(self, role: str, text: str) -> None:
        t = (text or "").strip()
        if not t or not self._call_id:
            return
        # Evita duplicados si llegan conversation_item_added + user_input_transcribed.
        key = f"{role}:{t}"
        if key in self._logged:
            return
        self._logged.add(key)
        if len(self._logged) > 400:
            self._logged.clear()
        if role == "assistant":
            self._last_assistant_text = t
        elif role == "user":
            self._recent_user_texts.append(t)
            if len(self._recent_user_texts) > 8:
                self._recent_user_texts = self._recent_user_texts[-8:]
        await _post(
            self._client,
            f"/voice/sessions/{self._call_id}/turn",
            {"role": role, "text": t},
        )

    def _prefer_english_goodbye(self) -> bool:
        users = self._recent_user_texts[-4:]
        if not users:
            return False
        en = sum(
            1
            for t in users
            if re.search(
                r"\b(hello|hi|yes|please|thanks|thank you|goodbye|looking|house|email|right)\b",
                t,
                re.I,
            )
        )
        es = sum(
            1
            for t in users
            if re.search(
                r"\b(hola|sí|si|gracias|vale|casa|piso|correo|perfecto|venga)\b",
                t,
                re.I,
            )
        )
        return en > es

    @staticmethod
    def _looks_like_goodbye(text: str) -> bool:
        t = (text or "").strip().lower()
        if not t:
            return False
        return bool(
            re.search(
                r"\b(un saludo|gracias por llamarn|goodbye|thanks for calling|"
                r"hasta luego|que vaya bien)\b",
                t,
                re.I,
            )
        )

    async def _do_hangup(self) -> None:
        """Expulsa al participante SIP y borra la room para cortar la línea ya."""
        if not self._room_name:
            return
        lkapi = api.LiveKitAPI()
        try:
            if self._sip_identity:
                try:
                    await lkapi.room.remove_participant(
                        api.RoomParticipantIdentity(
                            room=self._room_name,
                            identity=self._sip_identity,
                        )
                    )
                    logger.info("Participante SIP expulsado: %s", self._sip_identity)
                except Exception as e:  # noqa: BLE001
                    logger.warning("remove_participant: %s", e)
            await lkapi.room.delete_room(api.DeleteRoomRequest(room=self._room_name))
            logger.info("Llamada colgada (room eliminada): %s", self._room_name)
        except Exception as e:  # noqa: BLE001
            logger.warning("No se pudo colgar la llamada: %s", e)
        finally:
            await lkapi.aclose()

    async def _hangup_after_goodbye(self, ctx: RunContext) -> None:
        """Espera el audio en curso, dice la despedida si falta, y cuelga.

        Con OpenAI Realtime, session.say() no está disponible (no hay TTS aparte):
        hay que pedir la despedida con generate_reply.
        """
        if self._hangup_scheduled or not self._room_name:
            return
        self._hangup_scheduled = True
        try:
            try:
                ctx.disallow_interruptions()
            except Exception:  # noqa: BLE001
                pass
            # Si el modelo ya empezó a despedirse, deja que termine de sonar.
            try:
                await ctx.wait_for_playout()
            except Exception as e:  # noqa: BLE001
                logger.warning("wait_for_playout (previo): %s", e)

            if not self._looks_like_goodbye(self._last_assistant_text):
                goodbye = (
                    "Great, goodbye — thanks for calling us."
                    if self._prefer_english_goodbye()
                    else "Genial, pues un saludo, gracias por llamarnos."
                )
                try:
                    await ctx.session.generate_reply(
                        instructions=(
                            f'Di AHORA en voz alta, exactamente UNA sola vez y nada más, '
                            f'sin añadir nada: "{goodbye}". '
                            "Después silencio absoluto: no digas 'llamada finalizada' ni otra frase."
                        )
                    )
                    await ctx.wait_for_playout()
                    self._last_assistant_text = goodbye
                    if self._call_id:
                        await self._log_turn("assistant", goodbye)
                except Exception as e:  # noqa: BLE001
                    logger.warning("No se pudo decir la despedida: %s", e)
                    await asyncio.sleep(1.5)

            await asyncio.sleep(0.4)
        finally:
            await self._do_hangup()

    @function_tool
    async def buscar_propiedad(
        self,
        ctx: RunContext,
        ref: str | None = None,
        transaction_type: str | None = None,
        property_type: str | None = None,
        location_contains: str | None = None,
        max_price: float | str | None = None,
        min_price: float | str | None = None,
        min_bedrooms: int | float | str | None = None,
    ):
        """Busca inmuebles de Mambo Inmobiliaria (Vélez-Málaga, Torre del Mar y Costa del Sol Oriental).
        Úsala siempre antes de dar datos de una propiedad; nunca inventes precios ni características.

        Args:
            ref: Referencia exacta del anuncio de Idealista (6–12 dígitos, ej: 111673415).
            transaction_type: Venta, Alquiler, Traspaso, Alquiler Vacacional o Reformas.
            property_type: Tipo de inmueble (Piso, Chalet, Local...).
            location_contains: Zona (ej: Vélez-Málaga, Torre del Mar, Almayate, Periana).
            max_price: Precio máximo (número; si no lo sabes, omite el campo).
            min_price: Precio mínimo (número; si no lo sabes, omite el campo).
            min_bedrooms: Mínimo de habitaciones.
        """
        payload = {
            "call_id": self._call_id,
            "ref": ref,
            "transaction_type": transaction_type,
            "property_type": property_type,
            "location_contains": location_contains,
            "max_price": _opt_float(max_price),
            "min_price": _opt_float(min_price),
            "min_bedrooms": _opt_int(min_bedrooms),
        }
        return await _post(self._client, "/voice/tools/buscar-propiedad", payload)

    @function_tool
    async def derivar_comercial(
        self,
        ctx: RunContext,
        intent: str,
        name: str | None = None,
        phone: str | None = None,
        email: str | None = None,
        ref: str | None = None,
        summary: str | None = None,
    ):
        """Avisa al comercial con los datos del cliente. Úsala cuando ya tengas:
        en captación (vender / alquiler_propietario) los datos del inmueble más nombre y teléfono
        confirmado (email solo si lo da); en demanda (comprar/alquilar/visita) nombre, teléfono
        y ref si hay. El email NO es obligatorio: si el cliente no lo facilita, deriva igual.
        Tras derivar, el sistema manda al cliente por WhatsApp (y email si hay) la ficha y el
        contacto del comercial para la visita.

        Args:
            intent: comprar, alquilar, vender, alquiler_propietario, traspaso, visita, administrativo o alvaro.
            name: Nombre del cliente (obligatorio si lo tienes).
            phone: Teléfono de contacto. Si confirma el de la llamada, pásalo; si no, el que diga.
            email: Email del cliente si lo facilita (opcional; no bloquees la derivación sin email).
            ref: Referencia de la propiedad de interés.
            summary: Resumen completo (en captación: zona, tipo, dormitorios, baños, m², precio/renta, urgencia).
        """
        payload = {
            "call_id": self._call_id,
            "caller": self._caller,
            "intent": intent,
            "name": name,
            "phone": phone or self._caller,
            "email": email,
            "ref": ref,
            "summary": summary,
        }
        return await _post(self._client, "/voice/tools/derivar-comercial", payload)

    @function_tool
    async def enviar_whatsapp_cliente(
        self,
        ctx: RunContext,
        ref: str | None = None,
        text: str | None = None,
    ):
        """Envía al cliente por WhatsApp la ficha de una propiedad (por ref) o un texto.

        Args:
            ref: Referencia de la propiedad a enviar.
            text: Texto libre a enviar (si no se envía ficha por ref).
        """
        payload = {"caller": self._caller, "ref": ref, "text": text}
        return await _post(self._client, "/voice/tools/enviar-whatsapp", payload)

    @function_tool
    async def finalizar_llamada(
        self,
        ctx: RunContext,
        summary: str,
        intent: str | None = None,
    ):
        """Cierra la llamada: el sistema dice la despedida (si falta) y cuelga.

        Llámalo cuando el cliente diga que no necesita nada más (o equivalente).
        NO digas tú la despedida antes: esta tool se encarga. Tras invocarla:
        silencio absoluto. Prohibido decir "llamada finalizada" u otra frase.

        Args:
            summary: Resumen breve de la llamada.
            intent: Intención principal detectada.
        """
        # No POST /end aquí: el shutdown lo hace una sola vez (evita email duplicado).
        self._end_payload = {
            "summary": summary,
            "intent": intent,
            "disposition": "answered",
        }
        await self._hangup_after_goodbye(ctx)
        return (
            "SILENCIO_ABSOLUTO. No generes audio. No digas 'llamada finalizada'. "
            "La llamada ya se está cerrando."
        )


DEFAULT_WELCOME = f"{AGENCY_NAME} soy {VOICE_BOT_NAME} dígame"


def _phone_instruction_block(caller: str) -> str:
    if not caller or caller == "desconocido":
        return ""
    groups = caller[2:] if caller.startswith("34") and len(caller) >= 11 else caller
    if len(groups) == 9:
        spoken = f"{groups[:3]} {groups[3:5]} {groups[5:7]} {groups[7:9]}"
    else:
        spoken = groups
    return (
        f"\n\n## TELÉFONO DESDE EL QUE LLAMA\n"
        f"Llama desde +34 {groups}. Léelo como: {spoken}. "
        f"Confirma si el comercial puede devolver la llamada a ese número; "
        f"no pidas dictado dígito a dígito.\n"
    )


def _default_instructions(caller: str) -> str:
    """Instrucciones locales para arrancar sin esperar al backend."""
    return (
        f"Eres {VOICE_BOT_NAME}, recepcionista telefónica de {AGENCY_NAME} "
        "(Vélez-Málaga, Torre del Mar y Costa del Sol Oriental). "
        "Habla en español, claro y breve. No inventes precios ni disponibilidad: "
        "usa las herramientas buscar_propiedad y derivar_comercial. "
        "Tú hablas PRIMERO en la llamada (saludo de recepción). "
        "No saludes todavía: el sistema te indicará cuándo decir el saludo exacto. "
        "Si oyes un locutor de Idealista/Fotocasa/Habitasoft, no le contestes. "
        "Antes de derivar_comercial pide nombre y confirma el teléfono de la llamada; "
        "el email es opcional (si no lo da, deriva igual)."
        + _phone_instruction_block(caller)
    )


async def _wait_line_clear_then_ready(session: AgentSession) -> str:
    """Espera silencio en línea (o fin de anuncio de portal). Manuel saluda justo después.

    - Llamada directa (silencio): ~VOICE_WELCOME_QUIET_S y listo.
    - Locutor Idealista/etc. (habla detectada / transcripción portal): espera
      VOICE_WELCOME_SILENCE_S de silencio tras dejar de hablar, máx. VOICE_WELCOME_MAX_WAIT_S.
    """
    portal_re = re.compile(PORTAL_ANNOUNCE_RE, re.I)
    heard_speech = False
    heard_portal = False
    speaking = False
    last_speech_end: float | None = None
    wake = asyncio.Event()

    @session.on("user_state_changed")
    def _on_user_state(ev):  # noqa: ANN001
        nonlocal heard_speech, speaking, last_speech_end
        try:
            new = getattr(ev, "new_state", None)
            if new == "speaking":
                heard_speech = True
                speaking = True
                last_speech_end = None
            elif new in ("listening", "away"):
                if speaking:
                    last_speech_end = time.monotonic()
                speaking = False
            wake.set()
        except Exception:  # noqa: BLE001
            pass

    @session.on("user_input_transcribed")
    def _on_tx(ev):  # noqa: ANN001
        nonlocal heard_portal, heard_speech
        try:
            text = (getattr(ev, "transcript", None) or "").strip()
            if not text:
                return
            heard_speech = True
            if portal_re.search(text):
                heard_portal = True
                logger.info("Anuncio de portal detectado en línea: %r", text[:80])
            wake.set()
        except Exception:  # noqa: BLE001
            pass

    t_start = time.monotonic()
    reason = "timeout"
    while True:
        now = time.monotonic()
        elapsed = now - t_start
        if elapsed >= WELCOME_MAX_WAIT_S:
            reason = "max_wait"
            break

        if speaking:
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), timeout=0.15)
            except asyncio.TimeoutError:
                pass
            continue

        if heard_speech or heard_portal:
            # Hubo locutor/ruido: saluda tras silencio breve.
            if last_speech_end is None:
                last_speech_end = now
            quiet = now - last_speech_end
            if quiet >= WELCOME_SILENCE_S:
                reason = "portal_silence" if heard_portal else "speech_silence"
                break
        else:
            # Línea quieta desde el inicio → saludo rápido (Manuel habla primero).
            if elapsed >= WELCOME_QUIET_S:
                reason = "quiet_line"
                break

        wake.clear()
        remaining = WELCOME_MAX_WAIT_S - elapsed
        try:
            await asyncio.wait_for(wake.wait(), timeout=min(0.12, max(0.05, remaining)))
        except asyncio.TimeoutError:
            pass

    logger.info(
        "Línea lista para saludo (%.2fs, reason=%s, portal=%s, speech=%s)",
        time.monotonic() - t_start,
        reason,
        heard_portal,
        heard_speech,
    )
    return reason


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext):
    t0 = time.monotonic()
    await ctx.connect()
    logger.info("conectado a room en %.2fs", time.monotonic() - t0)

    client = httpx.AsyncClient(timeout=8.0)
    caller = _caller_from_participant(ctx) or "desconocido"

    instructions = _default_instructions(caller)

    # Estado mutable: la grabación y el call_id pueden resolverse en paralelo al saludo.
    state: dict = {
        "call_id": "",
        "egress_id": None,
        "audio_path": None,
        "welcome": DEFAULT_WELCOME,
    }

    agent = LaraAgent(instructions, client, caller, "", room_name=ctx.room.name)
    for p in ctx.room.remote_participants.values():
        agent._sip_identity = p.identity or ""
        if agent._sip_identity:
            break

    session = AgentSession(
        llm=openai.realtime.RealtimeModel(
            model=REALTIME_MODEL,
            voice=REALTIME_VOICE,
            speed=REALTIME_SPEED,
            turn_detection=_build_turn_detection(),
            input_audio_noise_reduction=InputAudioNoiseReduction(type=NOISE_REDUCTION),  # type: ignore[arg-type]
            input_audio_transcription=InputAudioTranscription(
                model=TRANSCRIBE_MODEL,  # type: ignore[arg-type]
                # Sin language fijo: permite ES/EN según hable el cliente.
            ),
        ),
    )

    @session.on("conversation_item_added")
    def _on_item(ev):  # noqa: ANN001
        try:
            item = ev.item
            role = getattr(item, "role", None)
            text = _extract_item_text(item)
            cid = agent._call_id or state["call_id"]
            if role in ("user", "assistant") and text and cid:
                if not agent._call_id:
                    agent._call_id = cid
                asyncio.create_task(agent._log_turn(role, text))
        except Exception as e:  # noqa: BLE001
            logger.warning("No se pudo registrar turno: %s", e)

    @session.on("user_input_transcribed")
    def _on_user_transcript(ev):  # noqa: ANN001
        try:
            if not getattr(ev, "is_final", False):
                return
            text = (getattr(ev, "transcript", None) or "").strip()
            cid = agent._call_id or state["call_id"]
            if text and cid:
                if not agent._call_id:
                    agent._call_id = cid
                asyncio.create_task(agent._log_turn("user", text))
        except Exception as e:  # noqa: BLE001
            logger.warning("No se pudo registrar transcript de usuario: %s", e)

    async def _backend_setup() -> None:
        """HTTP + grabación en paralelo al saludo (no bloquean el 'Hola')."""
        try:
            session_info, cfg = await asyncio.gather(
                _post(
                    client,
                    "/voice/sessions/start",
                    {"caller": caller, "called_did": os.getenv("ZADARMA_DID", "34951870058")},
                ),
                _get(client, f"/voice/lara/instructions?caller={caller}"),
            )
            cid = session_info.get("callId", "") or ""
            state["call_id"] = cid
            agent._call_id = cid

            remote_instr = (cfg or {}).get("instructions") or ""
            if remote_instr:
                if "TELÉFONO DESDE EL QUE LLAMA" not in remote_instr:
                    remote_instr = remote_instr + _phone_instruction_block(caller)
                try:
                    await agent.update_instructions(remote_instr)
                except Exception as e:  # noqa: BLE001
                    logger.warning("No se pudieron actualizar instrucciones: %s", e)

            w = (cfg or {}).get("welcome")
            if isinstance(w, str) and w.strip():
                state["welcome"] = w.strip()

            if cid:
                eg_id, path = await _start_recording(ctx.room.name, cid)
                state["egress_id"] = eg_id
                state["audio_path"] = path
            logger.info(
                "backend listo en %.2fs call_id=%s recording=%s",
                time.monotonic() - t0,
                cid[:8] if cid else "-",
                bool(state["egress_id"]),
            )
        except Exception as e:  # noqa: BLE001
            logger.error("backend_setup falló: %s", e)

    setup_task = asyncio.create_task(_backend_setup())

    async def _close():
        try:
            await asyncio.wait_for(setup_task, timeout=10)
        except Exception:  # noqa: BLE001
            pass
        eg = state.get("egress_id")
        if eg:
            await _stop_recording(eg)
        cid = agent._call_id or state.get("call_id") or ""
        if cid and not agent._ended_posted:
            agent._ended_posted = True
            try:
                for item in getattr(session.history, "items", []) or []:
                    role = getattr(item, "role", None)
                    text = _extract_item_text(item)
                    if role in ("user", "assistant") and text:
                        await agent._log_turn(role, text)
            except Exception as e:  # noqa: BLE001
                logger.warning("No se pudo volcar historial al cerrar: %s", e)
            payload = {
                "disposition": "answered",
                "audio_path": state.get("audio_path"),
                **(agent._end_payload or {}),
            }
            await _post(client, f"/voice/sessions/{cid}/end", payload)
        await client.aclose()

    ctx.add_shutdown_callback(_close)

    if _raw_voice not in _REALTIME_VOICES:
        logger.warning(
            "OPENAI_REALTIME_VOICE=%r no válida en Realtime; usando %s",
            _raw_voice,
            REALTIME_VOICE,
        )
    logger.info(
        "Realtime turn_mode=%s interrupt=%s voice=%s speed=%.2f (pre-saludo %.2fs)",
        TURN_MODE,
        INTERRUPT_RESPONSE,
        REALTIME_VOICE,
        REALTIME_SPEED,
        time.monotonic() - t0,
    )

    await session.start(agent=agent, room=ctx.room)
    logger.info("session.start ok en %.2fs — esperando línea libre para saludar", time.monotonic() - t0)
    # Manuel SIEMPRE habla primero. Si suena Idealista/Fotocasa, espera silencio y saluda.
    await _wait_line_clear_then_ready(session)
    if not setup_task.done():
        try:
            await asyncio.wait_for(asyncio.shield(setup_task), timeout=0.4)
        except Exception:  # noqa: BLE001
            pass
    welcome = (state.get("welcome") or DEFAULT_WELCOME).strip()
    logger.info("saludo: %s", welcome)
    await session.generate_reply(
        instructions=(
            f'Saluda AHORA tú primero, exactamente UNA sola vez, de un tirón, como recepción '
            f'telefónica en España (sin "hola" ni pausas largas): "{welcome}". '
            "No esperes a que el cliente hable antes de este saludo. "
            "Si antes sonó un anuncio de portal, ignóralo y saluda igual. "
            "Entonación natural y breve. Luego espera a que el cliente hable."
        )
    )


if __name__ == "__main__":
    from livekit.agents import cli

    cli.run_app(server)
