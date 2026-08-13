import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractBarePropertyRef,
  extractAllPropertyRefCandidates,
  extractPropertyRefFromText,
  parseSpokenPropertyRef,
  sanitizePropertyRef,
  catalogPropertyRef,
} from "./propertyRef.js";

describe("extractPropertyRefFromText", () => {
  it("entiende 'la referencia es la 1652'", () => {
    assert.equal(
      extractPropertyRefFromText(
        "Hola quiero hacer una visita en un chalet la referencia es la 1652",
      ),
      "1652",
    );
  });

  it("entiende 'la 1616' y 'la referencia es las 1616'", () => {
    assert.equal(extractPropertyRefFromText("la 1616"), "1616");
    assert.equal(extractPropertyRefFromText("la referencia es las 1616"), "1616");
    assert.equal(extractBarePropertyRef("dieciseis dieciseis"), "1616");
  });

  it("entiende 'Las Palmas 1616' (nombre + ref al final)", () => {
    assert.equal(extractPropertyRefFromText("Las Palmas 1616"), "1616");
    assert.equal(extractPropertyRefFromText("LAS PALMAS 1616"), "1616");
    assert.equal(extractBarePropertyRef("chalet en Mijas 1616"), "1616");
    assert.ok(extractAllPropertyRefCandidates("Las Palmas 1616").includes("1616"));
  });

  it("entiende referencia numérica corta", () => {
    assert.equal(extractPropertyRefFromText("referencia es 1652"), "1652");
    assert.equal(extractPropertyRefFromText("ref. 1553"), "1553");
    assert.equal(extractPropertyRefFromText("1652"), "1652");
    assert.equal(extractBarePropertyRef("ref 1652"), "1652");
  });

  it("extrae ref de URL inmobiliariabazan", () => {
    assert.equal(
      extractPropertyRefFromText(
        "https://www.inmobiliariabazan.com/propiedad?propiedad=1652",
      ),
      "1652",
    );
  });

  it("no confunde años ni textos largos sin ref", () => {
    assert.equal(extractPropertyRefFromText("Comprar"), null);
    assert.equal(sanitizePropertyRef("2024"), null);
    assert.equal(extractBarePropertyRef("presupuesto 1500 euros al mes"), null);
  });

  it("acepta ID de anuncio Idealista como ref de catálogo", () => {
    assert.equal(catalogPropertyRef("111673415"), "111673415");
    assert.equal(catalogPropertyRef("1652"), "1652");
    assert.equal(sanitizePropertyRef("111673415"), null);
  });
});

describe("parseSpokenPropertyRef", () => {
  it("entiende dígito a dígito", () => {
    assert.equal(parseSpokenPropertyRef("uno seis cinco dos"), "1652");
    assert.equal(parseSpokenPropertyRef("uno seis uno seis"), "1616");
  });

  it("entiende pares (dieciséis cincuenta y dos)", () => {
    assert.equal(parseSpokenPropertyRef("dieciséis cincuenta y dos"), "1652");
    assert.equal(parseSpokenPropertyRef("dieciseis cincuenta y dos"), "1652");
    assert.equal(parseSpokenPropertyRef("dieciséis dieciséis"), "1616");
  });

  it("entiende número completo en español", () => {
    assert.equal(parseSpokenPropertyRef("mil seiscientos cincuenta y dos"), "1652");
    assert.equal(parseSpokenPropertyRef("mil seiscientos dieciséis"), "1616");
  });

  it("entiende referencia dicha tras 'referencia es'", () => {
    assert.equal(
      extractPropertyRefFromText("la referencia es dieciséis cincuenta y dos"),
      "1652",
    );
    assert.equal(extractBarePropertyRef("dieciséis cincuenta y dos"), "1652");
    assert.equal(extractBarePropertyRef("mil seiscientos cincuenta y dos"), "1652");
  });

  it("tolera typo sesiscientos", () => {
    assert.equal(parseSpokenPropertyRef("mil sesiscientos cincuenta y dos"), "1652");
  });
});
