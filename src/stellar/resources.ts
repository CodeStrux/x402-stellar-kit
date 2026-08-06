import { xdr } from "@stellar/stellar-base";

import { WireError } from "../errors.js";

const MAX_I64 = (1n << 63n) - 1n;
const MAX_U32 = 0xffff_ffff;

export type SorobanResourceLimits = Readonly<{
  /** Maximum envelope fee, including the classic inclusion fee, in stroops. */
  maxFeeStroops: bigint;
  maxInstructions: number;
  maxDiskReadBytes: number;
  maxWriteBytes: number;
  maxFootprintEntries: number;
  maxTransactionDataBytes: number;
}>;

export type InspectedSorobanSimulation = Readonly<{
  sorobanData: xdr.SorobanTransactionData;
  totalFeeStroops: bigint;
  resources: Readonly<{
    instructions: number;
    diskReadBytes: number;
    writeBytes: number;
    readOnlyEntries: number;
    readWriteEntries: number;
    resourceFeeStroops: bigint;
  }>;
}>;

/** Conservative budget used only by this package's PLAY testnet demo/tests. */
export const TESTNET_DEMO_TRANSFER_LIMITS: SorobanResourceLimits = Object.freeze({
  maxFeeStroops: 5_000_000n,
  maxInstructions: 10_000_000,
  maxDiskReadBytes: 1_000_000,
  maxWriteBytes: 1_000_000,
  maxFootprintEntries: 100,
  maxTransactionDataBytes: 262_144,
});

const boundedU32 = (value: number, field: string): number => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new WireError(`Soroban resource limit ${field} must be a u32 integer`);
  }
  return value;
};

export const validateSorobanResourceLimits = (
  limits: SorobanResourceLimits,
): SorobanResourceLimits => {
  if (limits === null || typeof limits !== "object") {
    throw new WireError("Soroban resource limits are required");
  }
  if (
    typeof limits.maxFeeStroops !== "bigint" ||
    limits.maxFeeStroops < 1n ||
    limits.maxFeeStroops > MAX_I64
  ) {
    throw new WireError("Soroban max fee must be a positive i64 bigint in stroops");
  }
  boundedU32(limits.maxInstructions, "maxInstructions");
  boundedU32(limits.maxDiskReadBytes, "maxDiskReadBytes");
  boundedU32(limits.maxWriteBytes, "maxWriteBytes");
  boundedU32(limits.maxFootprintEntries, "maxFootprintEntries");
  boundedU32(limits.maxTransactionDataBytes, "maxTransactionDataBytes");
  if (limits.maxTransactionDataBytes < 1) {
    throw new WireError("Soroban maxTransactionDataBytes must be positive");
  }
  return Object.freeze({ ...limits });
};

const parseFee = (value: string, field: string): bigint => {
  if (!/^\d+$/.test(value)) {
    throw new WireError(`Soroban simulation ${field} was not an unsigned integer`);
  }
  const fee = BigInt(value);
  if (fee > MAX_I64) {
    throw new WireError(`Soroban simulation ${field} exceeded the i64 range`);
  }
  return fee;
};

const assertMaximum = (
  actual: number,
  maximum: number,
  field: string,
): void => {
  if (actual > maximum) {
    throw new WireError(
      `Soroban simulation ${field} ${actual} exceeded the configured limit ${maximum}`,
    );
  }
};

/**
 * Parses the RPC-provided SorobanTransactionData before a custodial fee source
 * signs it. The RPC is a trust boundary: opaque simulation XDR must never be
 * copied into a fee-paying envelope without enforcing an operator budget.
 */
export const inspectSorobanSimulation = (
  simulation: Readonly<{ transactionData: string; minResourceFee: string }>,
  configuredLimits: SorobanResourceLimits,
  inclusionFeeStroops: bigint,
): InspectedSorobanSimulation => {
  const limits = validateSorobanResourceLimits(configuredLimits);
  if (inclusionFeeStroops < 0n || inclusionFeeStroops > MAX_I64) {
    throw new WireError("Soroban inclusion fee was outside the i64 range");
  }

  const maximumBase64Length = Math.ceil(limits.maxTransactionDataBytes / 3) * 4;
  if (
    simulation.transactionData.length === 0 ||
    simulation.transactionData.length > maximumBase64Length
  ) {
    throw new WireError(
      "Soroban simulation transaction data exceeded the configured byte limit",
    );
  }
  const raw = Buffer.from(simulation.transactionData, "base64");
  if (
    raw.length > limits.maxTransactionDataBytes ||
    raw.toString("base64") !== simulation.transactionData
  ) {
    throw new WireError(
      "Soroban simulation transaction data was not canonical bounded base64",
    );
  }

  let sorobanData: xdr.SorobanTransactionData;
  try {
    sorobanData = xdr.SorobanTransactionData.fromXDR(raw);
  } catch (error) {
    throw new WireError("Soroban simulation transaction data was malformed XDR", {
      cause: error,
    });
  }
  if (!sorobanData.toXDR().equals(raw)) {
    throw new WireError("Soroban simulation transaction data was not canonical XDR");
  }
  const resources = sorobanData.resources();
  const footprint = resources.footprint();
  const inspected = {
    instructions: resources.instructions(),
    diskReadBytes: resources.diskReadBytes(),
    writeBytes: resources.writeBytes(),
    readOnlyEntries: footprint.readOnly().length,
    readWriteEntries: footprint.readWrite().length,
    resourceFeeStroops: BigInt(sorobanData.resourceFee().toString()),
  };

  assertMaximum(
    inspected.instructions,
    limits.maxInstructions,
    "instructions",
  );
  assertMaximum(
    inspected.diskReadBytes,
    limits.maxDiskReadBytes,
    "read bytes",
  );
  assertMaximum(inspected.writeBytes, limits.maxWriteBytes, "write bytes");
  assertMaximum(
    inspected.readOnlyEntries + inspected.readWriteEntries,
    limits.maxFootprintEntries,
    "footprint entries",
  );
  if (inspected.resourceFeeStroops < 0n) {
    throw new WireError("Soroban simulation resource fee was negative");
  }

  const minimumResourceFee = parseFee(
    simulation.minResourceFee,
    "minimum resource fee",
  );
  if (inspected.resourceFeeStroops !== minimumResourceFee) {
    throw new WireError(
      "Soroban simulation resource fee differed from its minimum resource fee",
    );
  }
  const totalFeeStroops = inclusionFeeStroops + minimumResourceFee;
  if (totalFeeStroops > limits.maxFeeStroops || totalFeeStroops > MAX_I64) {
    throw new WireError(
      `Soroban simulation fee ${totalFeeStroops} exceeded the configured limit ${limits.maxFeeStroops}`,
    );
  }

  return Object.freeze({
    sorobanData,
    totalFeeStroops,
    resources: Object.freeze(inspected),
  });
};
