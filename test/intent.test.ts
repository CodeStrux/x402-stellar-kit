import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  intentHash,
  normalizeResourceUrl,
  paymentIntentFromRequirement,
  type PaymentIntent,
} from "../src/intent.js";

const baseIntent: PaymentIntent = {
  network: "stellar:testnet",
  scheme: "exact",
  asset: "asset-a",
  payTo: "payee-a",
  amountUnits: 100_000n,
  resourceUrl: "https://example.test/data?q=1",
  maxTimeoutSeconds: 60,
};

describe("resource URL normalization", () => {
  it("normalizes authority and fragments without changing path or query", () => {
    expect(
      normalizeResourceUrl(
        "HTTPS://EXAMPLE.TEST:443/Case-Sensitive?q=A%20B#ignored",
      ),
    ).toBe("https://example.test/Case-Sensitive?q=A%20B");
    expect(normalizeResourceUrl("http://EXAMPLE.TEST:80/path#x")).toBe(
      "http://example.test/path",
    );
  });
});

describe("canonical JSON", () => {
  it("sorts keys recursively, removes whitespace, and quotes bigint", () => {
    expect(
      canonicalJson({ z: 1, nested: { b: 2n, a: [3, { d: 4, c: 5 }] } }),
    ).toBe('{"nested":{"a":[3,{"c":5,"d":4}],"b":"2"},"z":1}');
  });

  it("is unaffected by source JSON whitespace", () => {
    expect(canonicalJson(JSON.parse('{\n  "b": 2,\n  "a": 1\n}'))).toBe(
      canonicalJson(JSON.parse('{"a":1,"b":2}')),
    );
  });

  it("sorts integer-like keys lexically at every depth", () => {
    expect(canonicalJson({ 10: "ten", 2: "two", nested: { 10: 1, 2: 2 } })).toBe(
      '{"10":"ten","2":"two","nested":{"10":1,"2":2}}',
    );
  });

  it("preserves an own __proto__ JSON key", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"x":1},"a":2}'))).toBe(
      '{"__proto__":{"x":1},"a":2}',
    );
  });
});

describe("approval challenge hash", () => {
  it("is stable under object key order", () => {
    const reordered = {
      maxTimeoutSeconds: 60,
      resourceUrl: "https://example.test/data?q=1",
      amountUnits: 100_000n,
      payTo: "payee-a",
      asset: "asset-a",
      scheme: "exact",
      network: "stellar:testnet",
    } as PaymentIntent;

    expect(intentHash(reordered)).toBe(intentHash(baseIntent));
    expect(intentHash(baseIntent)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["network", "stellar:pubnet"],
    ["scheme", "other"],
    ["asset", "asset-b"],
    ["payTo", "payee-b"],
    ["amountUnits", 100_001n],
    ["resourceUrl", "https://example.test/other?q=1"],
    ["maxTimeoutSeconds", 61],
  ] as const)("changes when bound field %s changes", (field, value) => {
    const changed = { ...baseIntent, [field]: value } as PaymentIntent;

    expect(intentHash(changed)).not.toBe(intentHash(baseIntent));
  });
});

describe("intent construction", () => {
  it("converts wire units to bigint and normalizes the resource URL", () => {
    expect(
      paymentIntentFromRequirement(
        {
          scheme: "exact",
          network: "stellar:testnet",
          amount: "100000",
          asset: "asset-a",
          payTo: "payee-a",
          maxTimeoutSeconds: 60,
        },
        "HTTPS://EXAMPLE.TEST:443/data#fragment",
      ),
    ).toEqual({
      ...baseIntent,
      resourceUrl: "https://example.test/data",
    });
  });
});
