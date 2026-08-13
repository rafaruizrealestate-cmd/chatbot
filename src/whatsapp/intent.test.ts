import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessBuyerTransactionType, isOwnerListingIntent, resolveLeadIntent } from "./intent.js";

describe("isOwnerListingIntent", () => {
  it("detecta propietario que quiere vender", () => {
    assert.equal(isOwnerListingIntent("quiero vender mi piso en el centro"), true);
    assert.equal(isOwnerListingIntent("tengo un local para alquilar"), true);
  });

  it("no confunde comprador que busca en venta", () => {
    assert.equal(isOwnerListingIntent("me gusta una casa en perchel norte en venta"), false);
    assert.equal(isOwnerListingIntent("busco piso en alquiler"), false);
  });

  it("detecta sin exclusiva y vender con la inmobiliaria", () => {
    assert.equal(
      isOwnerListingIntent("se puede vende con inmobiliaria bazan una casa sin exclusiva?"),
      true,
    );
    assert.equal(isOwnerListingIntent("quiero vender mi piso sin exclusiva no comprar ni alquiler"), true);
    assert.equal(isOwnerListingIntent("me gustaria vender con vosotros"), true);
  });
});

describe("guessBuyerTransactionType", () => {
  it("entiende en venta como compra", () => {
    assert.equal(
      guessBuyerTransactionType("casa en perchel norte en venta"),
      "Venta",
    );
  });

  it("entiende en alquiler como alquiler", () => {
    assert.equal(guessBuyerTransactionType("piso en alquiler en málaga"), "Alquiler");
  });
});

describe("resolveLeadIntent", () => {
  it("prioriza alquiler de la ficha sobre texto en venta", () => {
    assert.equal(
      resolveLeadIntent({ transaction_type: "Alquiler" }, "me interesa una casa en venta en idealista"),
      "A",
    );
  });

  it("marca alquiler por €/mes en plantilla pisos.com", () => {
    assert.equal(
      resolveLeadIntent(
        undefined,
        "Estoy interesado/a en su Piso de 90 m², 3 habitaciones y 1.400€/mes en Mijas.",
      ),
      "A",
    );
  });

  it("marca alquiler por habitación sin ficha", () => {
    assert.equal(
      resolveLeadIntent(undefined, "Hola me interesa la habitación para julio y agosto"),
      "A",
    );
  });

  it("mantiene C solo para propietario real", () => {
    assert.equal(resolveLeadIntent(undefined, "quiero vender mi piso con vosotros"), "C");
  });
});
