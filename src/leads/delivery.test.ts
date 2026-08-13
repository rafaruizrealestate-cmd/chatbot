import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDesenlaceSteps, resolveClientChannel } from "./delivery.js";

describe("delivery / desenlace", () => {
  it("marca histórico como parcial sin flags", () => {
    const { steps, parcial } = buildDesenlaceSteps({
      origin: "llamada",
      agent_name: "Miguel",
      ref: "1759",
    });
    assert.equal(parcial, true);
    assert.equal(steps[0]?.text.includes("llamada"), true);
    assert.match(steps[1]?.text ?? "", /sin detalle/i);
  });

  it("arma timeline completa de llamada", () => {
    const { steps, parcial } = buildDesenlaceSteps({
      origin: "llamada",
      agent_name: "Miguel",
      ref: "1759",
      client_wa: 1,
      agent_wa: 1,
      agent_email: 1,
      client_email: 0,
    });
    assert.equal(parcial, false);
    assert.ok(steps.some((s) => /WhatsApp al cliente/.test(s.text)));
    assert.ok(steps.some((s) => /WhatsApp a Miguel/.test(s.text)));
    assert.ok(steps.some((s) => /Email a Miguel/.test(s.text)));
  });

  it("resolveClientChannel prioriza WhatsApp", () => {
    assert.equal(resolveClientChannel({ whatsapp: true, email: true }), "whatsapp");
    assert.equal(resolveClientChannel({ whatsapp: false, email: true }), "email");
    assert.equal(resolveClientChannel({ whatsapp: null, email: null }), "none");
  });
});
