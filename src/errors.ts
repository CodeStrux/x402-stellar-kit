import type { PolicyCode } from "./policy/types.js";

export class X402KitError extends Error {
  declare readonly transmitted?: true;
  declare readonly intentHash?: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "X402KitError";
  }
}

export class PolicyDenied extends X402KitError {
  readonly code: PolicyCode;

  constructor(code: PolicyCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyDenied";
    this.code = code;
  }
}

export class ApprovalRequired extends X402KitError {
  readonly ref: string;
  readonly intentHash: string;

  constructor(ref: string, intentHash: string, message = "Payment approval required") {
    super(message);
    this.name = "ApprovalRequired";
    this.ref = ref;
    this.intentHash = intentHash;
  }
}

export class ApprovalDenied extends X402KitError {
  readonly code = "POL-DENIED" as const;

  constructor(message = "Payment approval denied", options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalDenied";
  }
}

export class BindingDrift extends X402KitError {
  readonly code = "POL-DRIFT" as const;

  constructor(message = "Signed transaction does not match the approved intent", options?: ErrorOptions) {
    super(message, options);
    this.name = "BindingDrift";
  }
}

export class UpstreamFailed extends X402KitError {
  readonly status: number;

  constructor(status: number, message = `Upstream request failed with status ${status}`) {
    super(message);
    this.name = "UpstreamFailed";
    this.status = status;
  }
}

export class WireError extends X402KitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WireError";
  }
}
