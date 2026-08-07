import { describe, expect, it } from "vitest";

import { X402_VERSION } from "../src/constants.js";
import { PolicyDenied, WireError } from "../src/errors.js";
import { selectPayableRequirement } from "../src/payer.js";
import {
  decodePaymentRequired,
  encodePaymentRequired,
  isExactOffer,
  type PaymentRequirements,
} from "../src/wire.js";

const network = "stellar:testnet";
const otherNetwork = "stellar:pubnet";

const exactOffer = (overrides: Partial<PaymentRequirements> = {}) => ({
  scheme: "exact",
  network,
  amount: "100000",
  asset: "asset-a",
  payTo: "payee-a",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
  ...overrides,
});

const challenge = (accepts: readonly unknown[]) =>
  Buffer.from(
    JSON.stringify({
      x402Version: X402_VERSION,
      error: "Payment required",
      resource: { url: "https://resource.example.test/paid" },
      accepts,
    }),
    "utf8",
  ).toString("base64");

/**
 * The defect these cover: `accepts` was `z.array(PaymentRequirementsSchema)`
 * with `scheme` pinned to the literal `"exact"`, and `z.array` fails whole if
 * any element fails. A 402 advertising both an `exact` offer and some other
 * rail was therefore discarded entirely as malformed wire data — throwing away
 * a perfectly payable offer sitting right beside the foreign one. Meanwhile
 * `POL-SCHEME`, documented in AGENTS.md and skill/SKILL.md, was unreachable
 * through the real payment path: the wire layer rejected non-exact schemes
 * before policy ever ran.
 */
describe("a challenge may advertise rails this kit cannot pay", () => {
  it("decodes a mixed-scheme challenge instead of discarding it", () => {
    const decoded = decodePaymentRequired(
      challenge([{ scheme: "upto", network, maxAmount: "500000" }, exactOffer()]),
    );

    expect(decoded.accepts).toHaveLength(2);
    const payable = decoded.accepts.filter(isExactOffer);
    expect(payable).toHaveLength(1);
    expect(payable[0]).toMatchObject({ scheme: "exact", amount: "100000" });
  });

  it("carries an unsupported offer as its scheme alone, retaining no foreign fields", () => {
    const decoded = decodePaymentRequired(
      challenge([{ scheme: "upto", network, maxAmount: "500000" }, exactOffer()]),
    );

    // `.strip()`, so nothing unvalidated can ride back out through
    // encodePaymentRequired later.
    expect(decoded.accepts[0]).toEqual({ scheme: "upto" });
  });

  it("still refuses an offer that claims our scheme but not our shape", () => {
    // This must not fall through to the permissive branch and survive as
    // `{ scheme: "exact" }` — it would pass the scheme filter and reach intent
    // construction with no amount and no payee.
    expect(() =>
      decodePaymentRequired(challenge([{ scheme: "exact", network }])),
    ).toThrow(WireError);
  });

  it("refuses to emit an offer on a rail it could not settle", () => {
    // Generous on decode, strict on encode: a resource server built on this kit
    // must never advertise a scheme it cannot honour.
    expect(() =>
      encodePaymentRequired({
        x402Version: X402_VERSION,
        resource: { url: "https://resource.example.test/paid" },
        accepts: [{ scheme: "upto", network, maxAmount: "1" }],
      }),
    ).toThrow(WireError);
  });
});

describe("selecting the offer to pay", () => {
  it("reports POL-SCHEME when nothing on offer uses the exact scheme", () => {
    // Not POL-NETWORK. The network was never the problem, and sending an
    // operator to check a network setting would waste their time.
    expect(() =>
      selectPayableRequirement([{ scheme: "upto" }, { scheme: "deferred" }], [network]),
    ).toThrow(PolicyDenied);
    try {
      selectPayableRequirement([{ scheme: "upto" }], [network]);
    } catch (error) {
      expect(error).toMatchObject({ code: "POL-SCHEME" });
    }
  });

  it("reports POL-NETWORK when a payable offer exists on the wrong network", () => {
    try {
      selectPayableRequirement([exactOffer({ network: otherNetwork })], [network]);
    } catch (error) {
      expect(error).toMatchObject({ code: "POL-NETWORK" });
    }
  });

  it("skips a payable offer on a disallowed network to reach one on an allowed network", () => {
    // Nothing else in the suite catches an `exactOffers[0]` regression.
    const chosen = selectPayableRequirement(
      [
        exactOffer({ network: otherNetwork, payTo: "payee-wrong" }),
        exactOffer({ network, payTo: "payee-right" }),
      ],
      [network],
    );

    expect(chosen).toMatchObject({ network, payTo: "payee-right" });
  });

  it("ignores foreign offers while choosing among the payable ones", () => {
    const chosen = selectPayableRequirement(
      [
        { scheme: "upto" },
        exactOffer({ network: otherNetwork }),
        exactOffer({ network, payTo: "payee-right" }),
      ],
      [network],
    );

    expect(chosen).toMatchObject({ network, payTo: "payee-right" });
  });
});
