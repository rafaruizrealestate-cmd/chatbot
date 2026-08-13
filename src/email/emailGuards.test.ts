import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  checkPollSendCap,
  normalizeEmailAddress,
  recordOutboundEmail,
  resetPollSendCount,
  validateOutboundRecipient,
} from "./emailGuards.js";

describe("normalizeEmailAddress", () => {
  it("extrae dirección entre corchetes", () => {
    assert.equal(
      normalizeEmailAddress('"Leo" <info@inmobiliariabazan.com>'),
      "info@inmobiliariabazan.com",
    );
  });
});

describe("validateOutboundRecipient", () => {
  it("bloquea buzón propio info@", () => {
    assert.equal(validateOutboundRecipient("info@inmobiliariabazan.com"), "own_mailbox");
  });

  it("permite alvaro (allowlist por defecto)", () => {
    assert.equal(validateOutboundRecipient("alvaro@inmobiliariabazan.com"), null);
  });

  it("permite clientes externos", () => {
    assert.equal(validateOutboundRecipient("cliente@gmail.com"), null);
  });
});

describe("poll send cap", () => {
  beforeEach(() => {
    resetPollSendCount();
  });

  it("bloquea tras superar límite por poll en memoria", () => {
    const max = Number(process.env.EMAIL_MAX_SENDS_PER_POLL ?? "5");
    for (let i = 0; i < max; i++) {
      recordOutboundEmail(`user${i}@test.com`, `subject ${i}`);
    }
    assert.equal(checkPollSendCap(), "poll_send_cap");
  });
});
