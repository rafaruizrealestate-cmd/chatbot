import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAllowedCustomerListingUrl, publicPropertyUrl } from "./propertyUrl.js";

describe("isAllowedCustomerListingUrl", () => {
  it("acepta el anuncio público de Idealista", () => {
    assert.equal(
      isAllowedCustomerListingUrl("https://www.idealista.com/inmueble/111673415/"),
      true,
    );
    assert.equal(
      isAllowedCustomerListingUrl(
        "https://www.idealista.com/pro/mambo-inmobiliaria/inmueble/111673415/",
      ),
      true,
    );
  });

  it("rechaza tracking y otros hosts", () => {
    assert.equal(isAllowedCustomerListingUrl("https://email.return.idealista.com/x"), false);
    assert.equal(isAllowedCustomerListingUrl("https://www.fotocasa.es/es/anuncio/1"), false);
  });
});

describe("publicPropertyUrl", () => {
  it("construye el anuncio Idealista desde la ref", () => {
    assert.equal(
      publicPropertyUrl({ ref: "111673415", url: null }),
      "https://www.idealista.com/inmueble/111673415/",
    );
  });
});
