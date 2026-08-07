export const POLICY_CODE_DESCRIPTIONS = Object.freeze({
  "POL-SCHEME": "The payment scheme is not exact.",
  "POL-NETWORK": "The payment network is not allowed.",
  "POL-ORIGIN": "The resource origin is not allowed.",
  "POL-PAYTO": "The recipient is not allowed.",
  "POL-ASSET": "The asset is not allowed.",
  "POL-TIMEOUT": "The payment timeout is outside the allowed bound.",
  "POL-MAX": "The payment amount is non-positive or exceeds the per-payment cap.",
  "POL-WINDOW": "The payment would exceed the rolling-window cap.",
  "POL-DRIFT": "The signed transaction does not match the approved intent.",
  "POL-DENIED": "The approver denied the payment.",
} as const);

export type PolicyCode = keyof typeof POLICY_CODE_DESCRIPTIONS;

export type PolicyConfig = Readonly<{
  allowedNetworks: readonly string[];
  originAllowlist: readonly string[] | "DISABLED";
  payToAllowlist: readonly string[] | "DISABLED";
  assetAllowlist: readonly string[] | "DISABLED";
  maxPaymentUnits: bigint;
  windowCapUnits: bigint;
  windowSeconds: number;
  maxTimeoutSeconds: number;
  autoApproveMaxUnits: bigint;
}>;

export type PolicyOutcome = "allow" | "approval_required" | "deny";

export type PolicyDecision = Readonly<{
  outcome: PolicyOutcome;
  code?: PolicyCode;
  reason: string;
}>;
