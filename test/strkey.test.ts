import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  decodeStrkey,
  encodeStrkey,
  isValidContractId,
  isValidEd25519PublicKey,
} from "../src/strkey.js";

const fixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(
        "../fixtures/x402/payment-required.decoded.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("Stellar strkeys", () => {
  it("validates the real account and contract addresses in the fixtures", async () => {
    const challenge = await fixture();
    const requirement = (challenge.accepts as Array<Record<string, unknown>>)[0];
    const settlement = JSON.parse(
      await readFile(
        new URL(
          "../fixtures/x402/settlement-response.decoded.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(isValidEd25519PublicKey(requirement.payTo as string)).toBe(true);
    expect(isValidEd25519PublicKey(settlement.payer as string)).toBe(true);
    expect(isValidContractId(requirement.asset as string)).toBe(true);
    expect(decodeStrkey(requirement.payTo as string).versionByte).toBe(48);
    expect(decodeStrkey(requirement.asset as string).versionByte).toBe(16);
  });

  it("round-trips supported payloads", async () => {
    const challenge = await fixture();
    const requirement = (challenge.accepts as Array<Record<string, unknown>>)[0];
    const original = requirement.payTo as string;
    const decoded = decodeStrkey(original);

    expect(decoded.payload).toHaveLength(32);
    expect(encodeStrkey(decoded.versionByte, decoded.payload)).toBe(original);
  });

  it("distinguishes a mutated checksum", async () => {
    const challenge = await fixture();
    const original = (
      challenge.accepts as Array<Record<string, unknown>>
    )[0].payTo as string;
    const replacement = original[45] === "A" ? "B" : "A";
    const mutated = `${original.slice(0, 45)}${replacement}${original.slice(46)}`;

    expect(() => decodeStrkey(mutated)).toThrow("Invalid strkey checksum");
  });

  it("distinguishes the wrong encoded length", async () => {
    const challenge = await fixture();
    const original = (
      challenge.accepts as Array<Record<string, unknown>>
    )[0].payTo as string;

    expect(() => decodeStrkey(original.slice(0, -1))).toThrow(
      "Invalid strkey length",
    );
  });

  it("distinguishes a bad base32 character", async () => {
    const challenge = await fixture();
    const original = (
      challenge.accepts as Array<Record<string, unknown>>
    )[0].payTo as string;
    const mutated = `${original.slice(0, 10)}0${original.slice(11)}`;

    expect(() => decodeStrkey(mutated)).toThrow("Invalid base32 character");
  });

  it("distinguishes an unsupported version byte", () => {
    const encoded = encodeStrkey(0, new Uint8Array(32));

    expect(() => decodeStrkey(encoded)).toThrow(
      "Unsupported strkey version byte",
    );
  });

  it("returns false instead of throwing from validators", () => {
    expect(isValidEd25519PublicKey("G-invalid")).toBe(false);
    expect(isValidContractId("C-invalid")).toBe(false);
  });
});
