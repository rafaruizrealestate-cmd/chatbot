import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatVoiceCallClientConfirmation,
  formatVoiceCallTranscriptEmail,
  resolveAgentEmailForVoice,
} from "./voiceLeadEmail.js";

describe("resolveAgentEmailForVoice", () => {
  it("resuelve email por teléfono del mapa por defecto", () => {
    const email = resolveAgentEmailForVoice({ name: "Miguel", phone: "34620555989" });
    assert.equal(email, "miguel@inmobiliariabazan.com");
  });

  it("resuelve David desde el mapa", () => {
    const email = resolveAgentEmailForVoice({ name: "David", phone: "34692682946" });
    assert.equal(email, "david@inmobiliariabazan.com");
  });

  it("resuelve email del administrativo", () => {
    const email = resolveAgentEmailForVoice({ name: "Administrativo", phone: "34672594724" });
    assert.equal(email, "admin@inmobiliariabazan.com");
  });
});

describe("formatVoiceCallClientConfirmation", () => {
  it("menciona llamada telefónica y comercial de visita al estilo Leo", () => {
    const text = formatVoiceCallClientConfirmation({
      name: "María",
      agent: { name: "Miguel", phone: "34620555989" },
      ref: "1616",
      summary: "Quiere visitar un piso en el centro.",
    });
    assert.match(text, /Hola María/);
    assert.match(text, /llamada telefónica/);
    assert.match(text, /1616/);
    assert.match(text, /inmobiliariabazan\.com\/propiedad\?propiedad=1616/);
    assert.match(text, /Tu comercial es Miguel/);
    assert.match(text, /coordinar una visita/);
  });
});

describe("formatVoiceCallTranscriptEmail", () => {
  it("incluye metadatos y turnos de cliente y Lara", () => {
    const { subject, text } = formatVoiceCallTranscriptEmail({
      call: {
        id: "call-1",
        pbx_call_id: null,
        caller: "34646424563",
        called_did: "34951870058",
        language: "es",
        intent: "visita",
        summary: "Quiere visitar la 1616",
        disposition: "answered",
        audio_path: null,
        started_at: "2026-08-01 10:00:00",
        ended_at: "2026-08-01 10:03:00",
      },
      turns: [
        { role: "assistant", text: "Hola, soy Lara.", ts: "2026-08-01 10:00:01" },
        { role: "user", text: "Quiero ver un piso.", ts: "2026-08-01 10:00:10" },
      ],
    });
    assert.match(subject, /Transcripción llamada/);
    assert.match(subject, /\+34 646/);
    assert.match(text, /call-1/);
    assert.match(text, /visita/);
    assert.match(text, /Cliente:/);
    assert.match(text, /Quiero ver un piso/);
    assert.match(text, /Hola, soy Lara/);
  });
});
