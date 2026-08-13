import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  discoverIdealistaIdsFromHtml,
  parseIdealistaPropertyHtml,
  parseIdealistaListingCards,
} from "./idealista.js";

const LIST_HTML = `
<article class="item-multimedia-container item " data-element-id="111673415">
  <a href="/pro/mambo-inmobiliaria/inmueble/111673415/" class="item-link" title="Piso en Calle Sillares, 8"></a>
</article>
<article class="item-multimedia-container item " data-element-id="111016066">
  <a href="/pro/mambo-inmobiliaria/inmueble/111016066/" class="item-link" title="Piso en Periana"></a>
</article>
`;

const ITEM_HTML = `
<html>
  <h1><span class="main-info__title-main">Piso en venta en Calle Sillares, 8</span></h1>
  <span class="main-info__title-minor">Almayate Bajo, Vélez-Malaga</span>
  <span class="info-data-price"><span class="txt-bold">329.900</span> €</span>
  <span class="pricedown_price">349.900 €</span>
  <div id="details" class="details-box">
    <div class="details-property_features">
      <ul>
        <li>117 m² construidos, 110 m² útiles</li>
        <li>2 habitaciones</li>
        <li>2 baños</li>
        <li>Terraza</li>
        <li>Plaza de garaje incluida en el precio</li>
      </ul>
    </div>
  </div>
  <div class="adCommentsLanguage">
    <p>¡VENTA!<br>117 M2<br>Urbanización privada con piscina.</p>
  </div>
  <script>var config = { operation: 'sale', typology: 'home' };</script>
</html>
`;

describe("idealista scraper", () => {
  it("descubre IDs del listado profesional", () => {
    assert.deepEqual(discoverIdealistaIdsFromHtml(LIST_HTML), ["111673415", "111016066"]);
  });

  it("parsea tarjetas del listado profesional", () => {
    const rows = parseIdealistaListingCards(LIST_HTML, "Venta");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.ref, "111673415");
    assert.match(rows[0]!.title, /Sillares/);
    assert.equal(rows[0]!.url, "https://www.idealista.com/inmueble/111673415/");
  });

  it("parsea ficha de Idealista", () => {
    const row = parseIdealistaPropertyHtml(ITEM_HTML, "111673415");
    assert.ok(row);
    assert.equal(row!.ref, "111673415");
    assert.equal(row!.title, "Piso en venta en Calle Sillares, 8");
    assert.equal(row!.property_type, "Piso");
    assert.equal(row!.transaction_type, "Venta");
    assert.equal(row!.price, 329900);
    assert.equal(row!.area_m2, 117);
    assert.equal(row!.bedrooms, 2);
    assert.equal(row!.bathrooms, 2);
    assert.match(row!.location ?? "", /Almayate Bajo/);
    assert.match(row!.description ?? "", /Urbanización privada/);
    assert.equal(row!.url, "https://www.idealista.com/inmueble/111673415/");
  });
});
