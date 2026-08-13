import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPhoneFromText,
  formatPhoneForDisplay,
  parsePhoneToE164Digits,
} from "./phone.js";

test("parsePhoneToE164Digits respeta +33 francés (no fuerza +34)", () => {
  assert.equal(parsePhoneToE164Digits("+33 6 59 82 37 69"), "33659823769");
  assert.equal(formatPhoneForDisplay("33659823769"), "+33 6 59 82 37 69");
});

test("parsePhoneToE164Digits respeta +49 alemán (no inventa 609… como español)", () => {
  assert.equal(parsePhoneToE164Digits("+49 160 94683108"), "4916094683108");
  assert.notEqual(parsePhoneToE164Digits("+49 160 94683108"), "34609468310");
});

test("parsePhoneToE164Digits mantiene móviles españoles", () => {
  assert.equal(parsePhoneToE164Digits("+34613198239"), "34613198239");
  assert.equal(parsePhoneToE164Digits("613 19 82 39"), "34613198239");
  assert.equal(parsePhoneToE164Digits("[tel:+34613198239]"), "34613198239");
});

test("parsePhoneToE164Digits bloquea atención al cliente Fotocasa", () => {
  assert.equal(parsePhoneToE164Digits("+34900823825"), null);
  assert.equal(parsePhoneToE164Digits("900 823 825"), null);
});

test("parsePhoneToE164Digits corrige +340… de Fotocasa (móvil extranjero con 0 local)", () => {
  assert.equal(parsePhoneToE164Digits("+340657727867"), "657727867");
});

test("extractPhoneFromText prioriza internacional en email mezclado", () => {
  const text = [
    "Datos de la persona interesada",
    "Nombre: Marie",
    "Teléfono: +33 6 59 82 37 69",
    "También 672 594 724 corporativo",
  ].join("\n");
  assert.equal(extractPhoneFromText(text), "33659823769");
});

test("extractPhoneFromText no confunde alemán con español", () => {
  const text = "Teléfono: +49 160 94683108 [tel:+4916094683108]";
  assert.equal(extractPhoneFromText(text), "4916094683108");
});
