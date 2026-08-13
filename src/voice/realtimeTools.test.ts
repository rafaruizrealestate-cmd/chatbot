import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  locationSearchVariants,
  resolveVoiceAgent,
  summarizePropertyForVoice,
  withPriceMargin,
} from "./realtimeTools.js";
import type { PropertyRow } from "../knowledge/properties.js";
import { config } from "../config.js";

const baseProperty: PropertyRow = {
  ref: "1616",
  title: "Piso en el Centro",
  property_type: "Piso",
  transaction_type: "Venta",
  price: 250000,
  area_m2: 90,
  bedrooms: 3,
  bathrooms: 2,
  location: "Centro, Málaga",
  features: "terraza",
  description: "Luminoso piso reformado con terraza.",
  url: "https://www.inmobiliariabazan.com/propiedad?propiedad=1616",
  agent_name: null,
  agent_phone: null,
};

describe("locationSearchVariants", () => {
  it("extrae Castilla desde calle Castilla", () => {
    const v = locationSearchVariants("calle Castilla");
    assert.ok(v.some((x) => /^castilla$/i.test(x)));
  });

  it("normaliza Carlos de Haya", () => {
    const v = locationSearchVariants("Carlos de Haya");
    assert.ok(v.some((x) => /carlos\s+haya/i.test(x)));
  });
});

describe("withPriceMargin", () => {
  it("amplía max_price ~10% (1400 → encuentra 1350)", () => {
    const { max_price } = withPriceMargin(1400, undefined);
    assert.ok(max_price != null && max_price >= 1500);
    assert.ok(max_price! >= 1350);
  });
});

describe("resolveVoiceAgent", () => {
  it("usa el comercial de la ficha cuando existe", () => {
    const agent = resolveVoiceAgent("comprar", {
      ...baseProperty,
      agent_name: "David",
      agent_phone: "34692682946",
    });
    assert.equal(agent.name, "David");
    assert.equal(agent.phone, "34692682946");
  });

  it("compra/alquiler/visita van al comercial de compradores por defecto", () => {
    for (const intent of ["comprar", "alquilar", "visita"] as const) {
      const agent = resolveVoiceAgent(intent, null);
      assert.equal(agent.phone, "34620555989");
    }
  });

  it("propietario/traspaso van al comercial de propietarios por defecto", () => {
    for (const intent of ["vender", "alquiler_propietario", "traspaso"] as const) {
      const agent = resolveVoiceAgent(intent, null);
      assert.equal(agent.phone, "34646424563");
    }
  });

  it("administrativo va al teléfono de admin (sin ficha)", () => {
    const agent = resolveVoiceAgent("administrativo", {
      ...baseProperty,
      agent_name: "David",
      agent_phone: "34692682946",
    });
    assert.equal(agent.name, config.voiceAdminName);
    assert.equal(agent.phone, "34672594724");
  });

  it("alvaro (pedir por nombre) va al móvil de Álvaro, no al de la ficha", () => {
    const agent = resolveVoiceAgent("alvaro", {
      ...baseProperty,
      agent_name: "David",
      agent_phone: "34692682946",
    });
    assert.equal(agent.name, "Álvaro");
    assert.equal(agent.phone, "34646424563");
  });
});

describe("summarizePropertyForVoice", () => {
  it("incluye referencia, precio en euros y no URLs largas", () => {
    const s = summarizePropertyForVoice(baseProperty);
    assert.match(s, /referencia 1616/);
    assert.match(s, /euros/);
    assert.doesNotMatch(s, /https?:\/\//);
  });
});
