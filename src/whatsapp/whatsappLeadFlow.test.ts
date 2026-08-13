import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendAskNameIfNeeded,
  detectWhatsappHandoffInterest,
  buildOwnerListingReply,
  ensureAssignedAgentContact,
  hasValidCustomerName,
  isOffTopicFromOwnerFlow,
  isProfileRefStale,
  shouldAskNameForHandoff,
  shouldNotifyWhatsappAgentLead,
  shouldUseOwnerListingReply,
  summarizeWhatsappClientIntent,
} from "./whatsappLeadFlow.js";

describe("hasValidCustomerName", () => {
  it("rechaza saludos como nombre", () => {
    assert.equal(hasValidCustomerName("hola"), false);
    assert.equal(hasValidCustomerName("Álvaro"), true);
  });
});

describe("detectWhatsappHandoffInterest", () => {
  it("detecta elección de lista y visita", () => {
    assert.equal(detectWhatsappHandoffInterest("el 2", "1721"), true);
    assert.equal(detectWhatsappHandoffInterest("quiero visitarla", null), true);
    assert.equal(detectWhatsappHandoffInterest("busco piso en perchel", null), false);
  });
});

describe("shouldNotifyWhatsappAgentLead", () => {
  it("solo notifica con ref, nombre e interés", () => {
    assert.equal(
      shouldNotifyWhatsappAgentLead({
        normalizedText: "me llamo Juan y quiero visitarla",
        chosenRef: "1697",
        customerName: "Juan",
        refFromListPick: null,
        missedCallFollowUp: false,
        administrativeConversation: false,
      }),
      true,
    );
    assert.equal(
      shouldNotifyWhatsappAgentLead({
        normalizedText: "busco en perchel",
        chosenRef: "1697",
        customerName: "Juan",
        refFromListPick: null,
        missedCallFollowUp: false,
        administrativeConversation: false,
      }),
      false,
    );
    assert.equal(
      shouldNotifyWhatsappAgentLead({
        normalizedText: "quiero visitarla",
        chosenRef: "1697",
        customerName: null,
        refFromListPick: null,
        missedCallFollowUp: false,
        administrativeConversation: false,
      }),
      false,
    );
  });
});

describe("shouldAskNameForHandoff", () => {
  it("pide nombre si hay interés y ref pero no nombre válido", () => {
    assert.equal(
      shouldAskNameForHandoff({
        isDirectWhatsApp: true,
        chosenRef: "1697",
        customerName: "hola",
        normalizedText: "me interesa la ref 1697",
        refFromListPick: "1697",
      }),
      true,
    );
  });
});

describe("isProfileRefStale", () => {
  it("ignora ref antigua si el cliente busca otra zona", () => {
    assert.equal(
      isProfileRefStale("1533", "casa en perchel norte en venta", [], null),
      true,
    );
    assert.equal(
      isProfileRefStale("1533", "quiero la ref 1533", [], null),
      false,
    );
  });
});

describe("summarizeWhatsappClientIntent", () => {
  it("resume búsqueda, elección e interés de visita", () => {
    const s = summarizeWhatsappClientIntent({
      userMessages: [
        "hola",
        "me gusta una casa en perchel norte en venta",
        "el 2",
        "quiero visitarla",
        "me llamo Juan",
      ],
      chosenRef: "1697",
      propertyTitle: "Esperanto",
      propertyLocation: "Perchel Norte / La Trinidad en Málaga",
      transactionType: "Venta",
    });
    assert.match(s, /compra/i);
    assert.match(s, /Perchel/i);
    assert.match(s, /1697/);
    assert.match(s, /visitar/i);
  });
});

describe("appendAskNameIfNeeded", () => {
  it("añade pregunta de nombre si no está", () => {
    const out = appendAskNameIfNeeded("Ficha enviada.", { name: "Miguel", phone: "34600000000" });
    assert.match(out, /nombre completo/i);
  });
});

describe("ensureAssignedAgentContact", () => {
  it("añade Telf si el modelo solo pone el nombre", () => {
    const out = ensureAssignedAgentContact(
      "El comercial asignado es **David**, y te contactará pronto.",
      { name: "David", phone: "34692682946" },
    );
    assert.match(out, /Telf: \+34 692 682 946/);
    assert.match(out, /te contactará pronto/);
  });

  it("no duplica si ya hay teléfono", () => {
    const base = "Tu comercial es David, Telf: +34 692 682 946.";
    const out = ensureAssignedAgentContact(base, { name: "David", phone: "34692682946" });
    assert.equal(out, base);
  });
});

describe("shouldUseOwnerListingReply", () => {
  const ownerHistory = [
    {
      role: "user" as const,
      content: "pues estoy interesado en alquilar mi piso me explicas como trabajais?",
    },
    { role: "assistant" as const, content: "WhatsApp Álvaro registro-vendedor.php" },
  ];

  it("sigue en hilo propietario con seguimiento coherente", () => {
    assert.equal(
      shouldUseOwnerListingReply("esta en el perchel, alquiler", ownerHistory),
      true,
    );
  });

  it("sale del hilo propietario con mensajes ajenos", () => {
    assert.equal(isOffTopicFromOwnerFlow("cuanto es 2x2"), true);
    assert.equal(shouldUseOwnerListingReply("cuanto es 2x2", ownerHistory), false);
    assert.equal(shouldUseOwnerListingReply("busco un resultado dos por dos", ownerHistory), false);
    assert.equal(shouldUseOwnerListingReply("me gusta un piso en venta en perchel", ownerHistory), false);
  });
});

describe("buildOwnerListingReply contextual", () => {
  const askedZoneHistory = [
    { role: "user" as const, content: "quiero vender mi piso sin exclusiva" },
    {
      role: "assistant" as const,
      content: "Si quieres que gestionemos... ¿En qué zona está el inmueble y prefieres venta o alquiler?",
    },
  ];

  it("confirma handoff cuando piden que llame Álvaro", () => {
    const reply = buildOwnerListingReply(null, "otra vez? que me llame el alvaro ese", askedZoneHistory);
    assert.match(reply, /Le paso tus datos a Álvaro/i);
    assert.doesNotMatch(reply, /¿En qué zona/i);
  });

  it("confirma handoff cuando ya dio zona y detalles", () => {
    const reply = buildOwnerListingReply(
      null,
      "en el centro de malaga es un piso de 3 habitaciones",
      askedZoneHistory,
    );
    assert.match(reply, /Le paso tus datos a Álvaro/i);
    assert.doesNotMatch(reply, /¿En qué zona/i);
  });

  it("explica servicios si pregunta cómo trabajáis", () => {
    const reply = buildOwnerListingReply(null, "me explicas como trabajais?", []);
    assert.match(reply, /Tour 360/i);
  });
});
