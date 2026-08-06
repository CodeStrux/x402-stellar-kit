import { describe, expect, it } from "vitest";

import {
  ApprovalDenied,
  ApprovalRequired,
  BindingDrift,
  PolicyDenied,
  UpstreamFailed,
  WireError,
  X402KitError,
} from "../src/errors.js";

describe("kit errors", () => {
  it("gives the base error a stable name", () => {
    const error = new X402KitError("base message");

    expect(error.name).toBe("X402KitError");
    expect(error.message).toBe("base message");
  });

  it("preserves stable subclass names and structured context", () => {
    expect(new PolicyDenied("POL-MAX", "too much")).toMatchObject({
      name: "PolicyDenied",
      code: "POL-MAX",
    });
    expect(new ApprovalRequired("ref-1", "hash-1")).toMatchObject({
      name: "ApprovalRequired",
      ref: "ref-1",
      intentHash: "hash-1",
    });
    expect(new ApprovalDenied()).toMatchObject({
      name: "ApprovalDenied",
      code: "POL-DENIED",
    });
    expect(new BindingDrift()).toMatchObject({
      name: "BindingDrift",
      code: "POL-DRIFT",
    });
    expect(new UpstreamFailed(503)).toMatchObject({
      name: "UpstreamFailed",
      status: 503,
    });
    expect(new WireError("bad wire").name).toBe("WireError");
  });
});
