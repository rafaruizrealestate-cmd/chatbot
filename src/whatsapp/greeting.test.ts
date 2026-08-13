import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGenericWhatsAppOpener, buildWhatsAppOpenerReply, shouldMentionAgentToCustomer } from "./greeting.js";

describe("isGenericWhatsAppOpener", () => {
  it("detecta saludos puros", () => {
    assert.equal(isGenericWhatsAppOpener("hola"), true);
    assert.equal(isGenericWhatsAppOpener("buenas tardes"), true);
  });

  it("no trata mensajes cortos al azar como saludo", () => {
    assert.equal(isGenericWhatsAppOpener("Gracias"), false);
    assert.equal(isGenericWhatsAppOpener("Seguimos con ese"), false);
    assert.equal(isGenericWhatsAppOpener("cuanto es 2x2"), false);
    assert.equal(isGenericWhatsAppOpener("eso que tiene que ver"), false);
  });

  it("no confunde consulta con saludo", () => {
    assert.equal(
      isGenericWhatsAppOpener("hola busco piso en malaga en alquiler"),
      false,
    );
  });

  it("no trata consulta de viviendas como saludo", () => {
    assert.equal(isGenericWhatsAppOpener("viviendas más baratas"), false);
  });
});

describe("shouldMentionAgentToCustomer", () => {
  it("no suelta el comercial solo porque ya hay nombre", () => {
    assert.equal(shouldMentionAgentToCustomer(null, false, "Rafa", "piso"), false);
  });

  it("sí lo menciona si pide visita o hay ficha", () => {
    assert.equal(shouldMentionAgentToCustomer(null, false, "Rafa", "quiero visita"), true);
    assert.equal(shouldMentionAgentToCustomer("111673415", true, null, "ok"), true);
  });
});

describe("buildWhatsAppOpenerReply", () => {
  it("no usa hola como nombre", () => {
    const reply = buildWhatsAppOpenerReply({
      isFirstTurn: false,
      customerName: "hola",
      activeRef: "1533",
      isValidName: (n) => Boolean(n && n.toLowerCase() !== "hola"),
    });
    assert.match(reply, /^Hola\./);
    assert.doesNotMatch(reply, /Hola, hola/i);
  });
});
