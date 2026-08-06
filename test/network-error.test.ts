import { describe, expect, it } from "vitest";

import { isTransientNetworkFailure } from "../src/network-error.js";

describe("transient network failure classification", () => {
  it.each([
    new Error("request timed out after 10000 ms"),
    new Error("upstream returned HTTP 408"),
    new Error("upstream returned HTTP 429"),
    new Error("upstream returned HTTP 503"),
    new Error("fetch failed", { cause: new Error("ECONNRESET") }),
    new Error("getaddrinfo EAI_AGAIN horizon-testnet.stellar.org"),
  ])("classifies %s as environmental", (error) => {
    expect(isTransientNetworkFailure(error)).toBe(true);
  });

  it.each([
    new Error("upstream returned HTTP 400"),
    new Error("Stellar RPC returned a malformed response"),
    new Error("Invalid transaction XDR"),
    new Error("Horizon returned malformed account data"),
    new Error("Friendbot address must be a valid Stellar public key"),
  ])("keeps %s as a code failure", (error) => {
    expect(isTransientNetworkFailure(error)).toBe(false);
  });
});
