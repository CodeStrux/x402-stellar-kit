import { SorobanDataBuilder } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { WireError } from "../../src/errors.js";
import {
  inspectSorobanSimulation,
  type SorobanResourceLimits,
} from "../../src/stellar/resources.js";

const limits: SorobanResourceLimits = {
  maxFeeStroops: 1_000n,
  maxInstructions: 1_000,
  maxDiskReadBytes: 1_000,
  maxWriteBytes: 1_000,
  maxFootprintEntries: 4,
  maxTransactionDataBytes: 1_024,
};

const transactionData = (overrides: {
  instructions?: number;
  diskReadBytes?: number;
  writeBytes?: number;
  resourceFee?: bigint;
} = {}): string =>
  new SorobanDataBuilder()
    .setResources(
      overrides.instructions ?? 100,
      overrides.diskReadBytes ?? 200,
      overrides.writeBytes ?? 300,
    )
    .setResourceFee(overrides.resourceFee ?? 400n)
    .build()
    .toXDR("base64");

describe("Soroban simulation resource inspection", () => {
  it("parses resource XDR and returns a bounded total fee", () => {
    const inspected = inspectSorobanSimulation(
      { transactionData: transactionData(), minResourceFee: "400" },
      limits,
      100n,
    );

    expect(inspected.totalFeeStroops).toBe(500n);
    expect(inspected.resources).toEqual({
      instructions: 100,
      diskReadBytes: 200,
      writeBytes: 300,
      readOnlyEntries: 0,
      readWriteEntries: 0,
      resourceFeeStroops: 400n,
    });
  });

  it.each([
    [
      "fee",
      {
        minResourceFee: "901",
        transactionData: transactionData({ resourceFee: 901n }),
      },
    ],
    [
      "instructions",
      { minResourceFee: "400", transactionData: transactionData({ instructions: 1_001 }) },
    ],
    [
      "read bytes",
      { minResourceFee: "400", transactionData: transactionData({ diskReadBytes: 1_001 }) },
    ],
    [
      "write bytes",
      { minResourceFee: "400", transactionData: transactionData({ writeBytes: 1_001 }) },
    ],
    [
      "resource fee",
      { minResourceFee: "500", transactionData: transactionData({ resourceFee: 501n }) },
    ],
  ])("rejects an over-budget %s", (_field, simulation) => {
    expect(() => inspectSorobanSimulation(simulation, limits, 100n)).toThrow(
      WireError,
    );
  });

  it("rejects malformed transaction-data XDR", () => {
    expect(() =>
      inspectSorobanSimulation(
        { transactionData: "AAAA", minResourceFee: "500" },
        limits,
        100n,
      ),
    ).toThrow(WireError);
  });
});
