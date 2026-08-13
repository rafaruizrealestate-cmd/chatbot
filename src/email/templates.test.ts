import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMAIL_LOGO_CID, emailBrandHeaderHtml, plainTextToEmailHtml } from "./templates.js";

describe("emailBrandHeaderHtml", () => {
  it("incluye logo CID y texto Inmobiliaria Bazán", () => {
    const html = emailBrandHeaderHtml();
    assert.match(html, /cid:logo@inmobiliariabazan\.com/);
    assert.match(html, /Inmobiliaria Bazán/);
    assert.match(html, /width="56"/);
    assert.doesNotMatch(html, /minimalistgoogle/);
    assert.doesNotMatch(html, /letter-spacing/);
  });

  it("plainTextToEmailHtml usa cabecera de marca, no foto hero", () => {
    const html = plainTextToEmailHtml("Nuevo lead ref 1759", { title: "Lead" });
    assert.match(html, /Inmobiliaria Bazán/);
    assert.match(html, /cid:logo@inmobiliariabazan\.com/);
    assert.doesNotMatch(html, /minimalistgoogle/);
  });

  it("omite cabecera si includeHeaderImage=false", () => {
    const html = plainTextToEmailHtml("transcripción", {
      title: "Transcripción",
      includeHeaderImage: false,
    });
    assert.doesNotMatch(html, /cid:logo/);
    assert.doesNotMatch(html, /width="56"/);
  });
});
