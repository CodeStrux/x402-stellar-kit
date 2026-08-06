import type { PaymentIntent } from "../intent.js";
import type { PolicyConfig, PolicyDecision, PolicyCode } from "./types.js";

const deny = (code: PolicyCode, reason: string): PolicyDecision => ({
  outcome: "deny",
  code,
  reason,
});

const listAllows = (
  list: readonly string[] | "DISABLED",
  value: string,
  name: "originAllowlist" | "payToAllowlist" | "assetAllowlist",
): boolean => {
  if (list === "DISABLED") {
    console.warn(`x402 policy warning: ${name} is DISABLED`);
    return true;
  }

  return list.includes(value);
};

const resourceOrigin = (resourceUrl: string): string | undefined => {
  try {
    const origin = new URL(resourceUrl).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

const originAllows = (
  list: readonly string[] | "DISABLED",
  resourceUrl: string,
): boolean => {
  if (list === "DISABLED") {
    console.warn("x402 policy warning: originAllowlist is DISABLED");
    return true;
  }

  const origin = resourceOrigin(resourceUrl);
  if (origin === undefined) {
    return false;
  }

  return list.some((entry) => resourceOrigin(entry) === origin);
};

export function evaluateProbeOrigin(
  url: string,
  config: PolicyConfig,
): PolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny("POL-ORIGIN", "Probe URL is invalid and cannot be parsed");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return deny(
      "POL-ORIGIN",
      `Probe URL must use HTTP(S), received ${parsed.protocol}`,
    );
  }

  if (!originAllows(config.originAllowlist, parsed.toString())) {
    return deny("POL-ORIGIN", "Probe origin is not allowed");
  }

  return { outcome: "allow", reason: "Probe origin is allowed" };
}

export const evaluate = (
  intent: PaymentIntent,
  config: PolicyConfig,
  spentInWindow: bigint,
  now: number,
): PolicyDecision => {
  void now;

  if ((intent as { scheme: string }).scheme !== "exact") {
    return deny("POL-SCHEME", "Only the exact payment scheme is allowed");
  }
  if (!config.allowedNetworks.includes(intent.network)) {
    return deny("POL-NETWORK", "Payment network is not allowed");
  }
  if (!originAllows(config.originAllowlist, intent.resourceUrl)) {
    return deny("POL-ORIGIN", "Resource origin is not allowed");
  }
  if (!listAllows(config.payToAllowlist, intent.payTo, "payToAllowlist")) {
    return deny("POL-PAYTO", "Payment recipient is not allowed");
  }
  if (!listAllows(config.assetAllowlist, intent.asset, "assetAllowlist")) {
    return deny("POL-ASSET", "Payment asset is not allowed");
  }
  if (
    !Number.isFinite(intent.maxTimeoutSeconds) ||
    !Number.isFinite(config.maxTimeoutSeconds) ||
    !(
      intent.maxTimeoutSeconds > 0 &&
      intent.maxTimeoutSeconds <= config.maxTimeoutSeconds
    )
  ) {
    return deny("POL-TIMEOUT", "Payment timeout exceeds policy");
  }
  if (intent.amountUnits <= 0n || intent.amountUnits > config.maxPaymentUnits) {
    return deny("POL-MAX", "Payment amount exceeds policy");
  }
  if (spentInWindow + intent.amountUnits > config.windowCapUnits) {
    return deny("POL-WINDOW", "Payment exceeds the rolling-window cap");
  }
  if (intent.amountUnits <= config.autoApproveMaxUnits) {
    return { outcome: "allow", reason: "Payment is within policy" };
  }

  return {
    outcome: "approval_required",
    reason: "Payment requires approval",
  };
};
