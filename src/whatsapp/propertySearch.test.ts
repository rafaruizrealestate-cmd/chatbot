import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPropertySearchSignals,
  hasPropertySearchIntent,
  wantsBroadCatalogListing,
} from "./propertySearch.js";
import { wantsListingLink } from "./customerPropertyMessage.js";

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

describe("wantsListingLink", () => {
  it("detecta pedir el enlace o las fotos", () => {
    assert.equal(wantsListingLink("pásame el enlace del anuncio"), true);
    assert.equal(wantsListingLink("quiero ver las fotos"), true);
    assert.equal(wantsListingLink("ok gracias"), false);
  });
});
