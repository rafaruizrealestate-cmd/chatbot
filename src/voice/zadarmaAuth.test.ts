import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildZadarmaSignature } from "./zadarmaAuth.js";

describe("zadarmaAuth", () => {
  it("buildZadarmaSignature concatena caller_id+called_did+call_start", () => {
    const sig = buildZadarmaSignature(
      ["34600111222", "34951870058", "2026-06-21 12:00:00"],
      "test-secret",
    );
    assert.ok(sig);
    assert.match(sig, /^[A-Za-z0-9+/]+=*$/);
  });
});
