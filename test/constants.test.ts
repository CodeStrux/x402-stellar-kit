import { describe, expect, it } from "vitest";

import {
  DECIMALS,
  HEADERS,
  NETWORKS,
  X402_VERSION,
  formatUnits,
  parseUnits,
} from "../src/constants.js";

describe("network constants", () => {
  it("exposes the pinned x402 and Stellar network values", () => {
    expect(X402_VERSION).toBe(2);
    expect(DECIMALS).toBe(7);
    expect(HEADERS).toEqual({
      paymentRequired: "PAYMENT-REQUIRED",
      paymentSignature: "PAYMENT-SIGNATURE",
      paymentResponse: "PAYMENT-RESPONSE",
    });
    expect(NETWORKS.testnet).toEqual({
      caip2: "stellar:testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      horizonUrl: "https://horizon-testnet.stellar.org",
      rpcUrl: "https://soroban-testnet.stellar.org",
      friendbotUrl: "https://friendbot.stellar.org",
    });
    expect(NETWORKS.pubnet).toEqual({
      caip2: "stellar:pubnet",
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      usdcContract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      horizonUrl: "https://horizon.stellar.org",
      rpcUrl: "",
      friendbotUrl: "",
    });
  });

  it("deeply freezes exported records", () => {
    expect(Object.isFrozen(NETWORKS)).toBe(true);
    expect(Object.isFrozen(NETWORKS.testnet)).toBe(true);
    expect(Object.isFrozen(HEADERS)).toBe(true);
    expect(() => {
      (NETWORKS.testnet as { caip2: string }).caip2 = "changed";
    }).toThrow(TypeError);
  });
});

describe("base-unit conversion", () => {
  it.each([
    ["0", 0n],
    ["0.01", 100_000n],
    ["1", 10_000_000n],
    ["1.0000001", 10_000_001n],
    ["001.20", 12_000_000n],
  ] as const)("parses %s without floating point", (decimal, units) => {
    expect(parseUnits(decimal)).toBe(units);
  });

  it.each(["", ".1", "1.", "1.00000001", "-1", "+1", "1e2", " 1"])(
    "rejects invalid decimal input %j",
    (decimal) => {
      expect(() => parseUnits(decimal)).toThrow("Invalid decimal amount");
    },
  );

  it.each([
    [0n, "0"],
    [100_000n, "0.01"],
    [10_000_000n, "1"],
    [10_000_001n, "1.0000001"],
    [-100_000n, "-0.01"],
  ] as const)("formats %s exactly", (units, decimal) => {
    expect(formatUnits(units)).toBe(decimal);
  });
});
