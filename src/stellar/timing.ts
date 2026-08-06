import { WireError } from "../errors.js";

export const STELLAR_LEDGER_SECONDS = 5;
export const MAX_AUTH_WINDOW_LEDGERS = 120;

export const authorizationWindowLedgers = (
  maxTimeoutSeconds: number,
): number => {
  if (!Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new WireError("Payment timeout must be positive and finite");
  }
  return Math.min(
    MAX_AUTH_WINDOW_LEDGERS,
    Math.max(1, Math.ceil(maxTimeoutSeconds / STELLAR_LEDGER_SECONDS)),
  );
};
