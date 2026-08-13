import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPropertySearchSignals,
  hasPropertySearchIntent,
  wantsBroadCatalogListing,
} from "./propertySearch.js";

describe("extractPropertySearchSignals — Mambo", () => {
  it("reconoce Vélez-Málaga y no lo colapsa a Málaga", () => {
    const s = extractPropertySearchSignals("en velez malaga");
    assert.match(s.location ?? "", /velez/i);
    assert.doesNotMatch(s.location ?? "", /^malaga$/i);
  });

  it("reconoce Torre del Mar", () => {
    const s = extractPropertySearchSignals("piso en torre del mar");
    assert.match(s.location ?? "", /torre del mar/i);
    assert.equal(s.propertyType, "Piso");
  });
});

describe("hasPropertySearchIntent", () => {
  it("trata 'viviendas más baratas' como búsqueda de catálogo", () => {
    assert.equal(hasPropertySearchIntent("viviendas más baratas"), true);
    assert.equal(wantsBroadCatalogListing("viviendas más baratas"), true);
  });
});
