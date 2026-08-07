import { WireError } from "../errors.js";

export const STELLAR_LEDGER_SECONDS = 5;
export const MAX_AUTH_WINDOW_LEDGERS = 120;

/**
 * The shortest payment timeout this kit will authorize.
 *
 * Below roughly two ledgers, an approved payment cannot realistically reach the
 * ledger: its time bounds are close to expired by the time it is signed. It
 * never settles — but the payer already transmitted it, and `markIndeterminate`
 * turned the reservation into a **non-expiring** debit only a human can clear.
 * A hostile resource server advertising a two-second timeout therefore drains a
 * rolling budget without ever taking a payment, and every refusal looks like an
 * ordinary network failure.
 *
 * Ported from the original policy engine, which required 10..300. The port to
 * this kit kept the ceiling (configurable here) and quietly dropped the floor.
 */
export const MIN_TIMEOUT_SECONDS = 10;

/** The longest, matching the authorization window this kit can express. */
export const MAX_TIMEOUT_SECONDS =
  MAX_AUTH_WINDOW_LEDGERS * STELLAR_LEDGER_SECONDS;

export const authorizationWindowLedgers = (
  maxTimeoutSeconds: number,
): number => {
  // The floor lives here as well as in the policy engine, because `Signer` is a
  // documented seam: an adopter may sign an intent this kit's policy engine
  // never saw. A bound only one caller enforces is not a bound.
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < MIN_TIMEOUT_SECONDS
  ) {
    throw new WireError(
      `Payment timeout must be a whole number of seconds, at least ${MIN_TIMEOUT_SECONDS}`,
    );
  }
  return Math.min(
    MAX_AUTH_WINDOW_LEDGERS,
    Math.max(1, Math.ceil(maxTimeoutSeconds / STELLAR_LEDGER_SECONDS)),
  );
};
