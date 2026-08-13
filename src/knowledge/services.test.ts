import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  wantsOwnerServicesDetail,
  wantsBuyerServicesDetail,
  formatOwnerServicesForWhatsApp,
  BAZAN_SERVICES_PROMPT_BLOCK,
} from "./services.js";

describe("wantsOwnerServicesDetail", () => {
  it("detecta preguntas sobre cómo trabajan", () => {
    assert.equal(
      wantsOwnerServicesDetail("pues estoy interesado en alquilar mi piso me explicas como trabajais?"),
      true,
    );
    assert.equal(wantsOwnerServicesDetail("haceis tour 360?"), true);
  });
});

describe("wantsBuyerServicesDetail", () => {
  it("detecta preguntas de servicios para compradores", () => {
    assert.equal(wantsBuyerServicesDetail("que servicios ofreceis para comprar?"), true);
    assert.equal(wantsBuyerServicesDetail("busco piso en malaga"), false);
  });
});

describe("formatOwnerServicesForWhatsApp", () => {
  it("incluye ASNEF y Tour 360", () => {
    const text = formatOwnerServicesForWhatsApp();
    assert.match(text, /Tour 360/i);
    assert.match(text, /ASNEF/i);
  });
});

describe("BAZAN_SERVICES_PROMPT_BLOCK", () => {
  it("incluye bloques propietarios y compradores", () => {
    assert.match(BAZAN_SERVICES_PROMPT_BLOCK, /PROPIETARIOS/i);
    assert.match(BAZAN_SERVICES_PROMPT_BLOCK, /COMPRADORES/i);
  });
});
