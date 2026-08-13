import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractIdealistaAdId, extractPortalAdRef } from "./portalListings.js";

describe("extractPortalAdRef", () => {
  it("extracts Idealista ad id from share URL", () => {
    assert.equal(
      extractIdealistaAdId(
        "https://www.idealista.com/inmueble/111835353/?utm_medium=socialmedia&utm_source=whatsapp"
      ),
      "111835353"
    );
  });

  it("extracts Cod. from Habitatsoft text", () => {
    assert.equal(extractIdealistaAdId("Cod. 111835353\nRef. 1736"), "111835353");
  });

  it("extracts Fotocasa ad id from listing URL", () => {
    assert.deepEqual(
      extractPortalAdRef(
        "https://www.fotocasa.es/es/alquiler/vivienda/malaga-capital/aire-acondicionado-calefaccion-ascensor-amueblado-television/190290228/d"
      ),
      { portal: "fotocasa", externalId: "190290228" }
    );
  });

  it("extracts pisos.com ad id from slug URL", () => {
    assert.deepEqual(
      extractPortalAdRef(
        "https://www.pisos.com/alquilar/piso-portada_alta_camino_de_antequera-65866607613_104700/?from_map=true"
      ),
      { portal: "pisos", externalId: "65866607613_104700" }
    );
  });
});
