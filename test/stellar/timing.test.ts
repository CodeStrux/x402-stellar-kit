import { describe, expect, it } from "vitest";

import { WireError } from "../../src/errors.js";
import {
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  authorizationWindowLedgers,
} from "../../src/stellar/timing.js";

/**
 * The floor cannot live only in the policy engine. `Signer` is a documented
 * production seam, so an adopter may sign an intent the engine never saw — and
 * before this, `authorizationWindowLedgers` would happily build a one-ledger
 * authorization for a one-second timeout. A bound only one caller enforces is
 * not a bound.
 */
describe("the authorization window enforces the same floor as policy", () => {
  it.each([1, 5, 9, 30.5, 0, -1] as const)("refuses %s seconds", (seconds) => {
    expect(() => authorizationWindowLedgers(seconds)).toThrow(WireError);
  });

  it("accepts the floor and the ceiling", () => {
    expect(authorizationWindowLedgers(MIN_TIMEOUT_SECONDS)).toBe(2);
    expect(authorizationWindowLedgers(MAX_TIMEOUT_SECONDS)).toBe(120);
  });

  it("states one range across the kit", () => {
    expect(MIN_TIMEOUT_SECONDS).toBe(10);
    expect(MAX_TIMEOUT_SECONDS).toBe(600);
  });
});
