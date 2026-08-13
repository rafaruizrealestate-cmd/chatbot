import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fingerprint,
  looksLikeOtherBotMessage,
  maxFingerprintCount,
  REPEAT_LIMIT,
  trailingRepeatStreak,
} from "./botLoopGuard.js";

describe("looksLikeOtherBotMessage", () => {
  it("detecta taller mecánico / no inmuebles", () => {
    assert.equal(
      looksLikeOtherBotMessage(
        "No gestionamos inmuebles, solo coches y citas en el taller. ¿Quieres que te ayude?"
      ),
      true
    );
  });

  it("no marca un cliente inmobiliario normal", () => {
    assert.equal(
      looksLikeOtherBotMessage("Busco un piso de alquiler en Carlos de Haya por unos 1400"),
      false
    );
  });
});

describe("misma pregunta ×3", () => {
  it("trailingRepeatStreak cuenta 3 iguales al final", () => {
    const q = "¿Qué tipo de inmueble es (piso, chalet, ático…)?";
    assert.equal(trailingRepeatStreak([q, q, q]), 3);
    assert.equal(trailingRepeatStreak(["Hola busco un piso", q, q, q]), 3);
    assert.equal(trailingRepeatStreak([q, q, "Hola busco un piso en el centro"]), 1);
  });

  it("maxFingerprintCount detecta la misma pregunta 3 veces aunque no sea consecutiva", () => {
    const q = "¿Qué tipo de inmueble es (piso, chalet, ático…)?";
    assert.ok(maxFingerprintCount([q, "hola", q, "ok", q], 10) >= REPEAT_LIMIT);
  });

  it("fingerprint normaliza puntuación", () => {
    assert.equal(
      fingerprint("¿Qué tipo de inmueble es?"),
      fingerprint("que tipo de inmueble es")
    );
  });
});
