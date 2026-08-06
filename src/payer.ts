import { randomUUID } from "node:crypto";

import { DenyAllApprover, type Approver } from "./approver/index.js";
import { HEADERS, X402_VERSION } from "./constants.js";
import {
  ApprovalDenied,
  PolicyDenied,
  UpstreamFailed,
  WireError,
  X402KitError,
} from "./errors.js";
import {
  intentHash as hashIntent,
  normalizeResourceUrl,
  paymentIntentFromRequirement,
} from "./intent.js";
import { evaluate, evaluateProbeOrigin } from "./policy/engine.js";
import type { PolicyConfig, PolicyDecision } from "./policy/types.js";
import { MemoryWindowStore, type WindowStore } from "./policy/window.js";
import type { Signer } from "./signer.js";
import {
  decodePaymentRequired,
  decodeSettlementResponse,
  encodePaymentPayload,
  type PaymentRequired,
  type SettlementResponse,
} from "./wire.js";

export type PayerOptions = Readonly<{
  signer: Signer;
  policy: PolicyConfig;
  window?: WindowStore;
  approver?: Approver;
  fetchLike?: typeof globalThis.fetch;
  now?: () => number;
}>;

export type PayResult = Readonly<{
  status: number;
  body: string;
  settlement: SettlementResponse;
  intentHash: string;
  amountUnits: bigint;
}>;

const copyList = (
  value: readonly string[] | "DISABLED",
): readonly string[] | "DISABLED" =>
  value === "DISABLED" ? value : Object.freeze([...value]);

const copyPolicy = (config: PolicyConfig): PolicyConfig =>
  Object.freeze({
    ...config,
    allowedNetworks: Object.freeze([...config.allowedNetworks]),
    originAllowlist: copyList(config.originAllowlist),
    payToAllowlist: copyList(config.payToAllowlist),
    assetAllowlist: copyList(config.assetAllowlist),
  });

const requestUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new WireError("Resource URL is invalid", { cause: error });
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new WireError("Resource URL must be an HTTP(S) URL without credentials");
  }
  return normalizeResourceUrl(parsed.toString());
};

const assertResponseUrl = (response: Response, expectedUrl: string): void => {
  if (response.url.length > 0 && requestUrl(response.url) !== expectedUrl) {
    throw new WireError("Upstream response URL differs from the requested resource");
  }
};

const throwIfDenied = (decision: PolicyDecision): void => {
  if (decision.outcome === "deny") {
    throw new PolicyDenied(
      decision.code ?? "POL-DENIED",
      decision.reason,
    );
  }
};

// Never follow redirects: an allowlisted origin could redirect the payer to an
// internal service and bypass the origin policy.
const REDIRECT_POLICY: RequestRedirect = "manual";

type TransmittedError = Error &
  Readonly<{
    transmitted: true;
    intentHash: string;
  }>;

const withTransmissionContext = (
  error: unknown,
  intentHash: string,
): TransmittedError => {
  const failure =
    error instanceof Error
      ? error
      : new X402KitError("Payment failed after signature transmission", {
          cause: error,
        });

  try {
    Object.defineProperties(failure, {
      transmitted: {
        value: true,
        enumerable: true,
        configurable: false,
      },
      intentHash: {
        value: intentHash,
        enumerable: true,
        configurable: false,
      },
    });
    return failure as TransmittedError;
  } catch {
    const wrapped = new X402KitError(failure.message, { cause: failure });
    Object.defineProperties(wrapped, {
      transmitted: { value: true, enumerable: true },
      intentHash: { value: intentHash, enumerable: true },
    });
    return wrapped as TransmittedError;
  }
};

export class Payer {
  readonly #signer: Signer;
  readonly #policy: PolicyConfig;
  readonly #window: WindowStore;
  readonly #approver: Approver;
  readonly #fetchLike: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #reservationNamespace = randomUUID();
  #reservationSequence = 0;

  constructor(options: PayerOptions) {
    this.#signer = options.signer;
    this.#policy = copyPolicy(options.policy);
    this.#window =
      options.window ?? new MemoryWindowStore(this.#policy.windowSeconds);
    this.#approver = options.approver ?? new DenyAllApprover();
    this.#fetchLike = options.fetchLike ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  async probe(url: string): Promise<PaymentRequired> {
    throwIfDenied(evaluateProbeOrigin(url, this.#policy));
    const normalizedUrl = requestUrl(url);
    const response = await this.#fetchLike(normalizedUrl, {
      method: "GET",
      redirect: REDIRECT_POLICY,
    });
    assertResponseUrl(response, normalizedUrl);
    if (response.status !== 402) {
      throw new UpstreamFailed(
        response.status,
        `Expected a 402 payment challenge, received ${response.status}`,
      );
    }

    const encoded = response.headers.get(HEADERS.paymentRequired);
    if (encoded === null) {
      throw new WireError("402 response is missing PAYMENT-REQUIRED");
    }
    const challenge = decodePaymentRequired(encoded);
    if (requestUrl(challenge.resource.url) !== normalizedUrl) {
      throw new WireError("Payment challenge resource differs from the requested URL");
    }
    return challenge;
  }

  async pay(url: string): Promise<PayResult> {
    const challenge = await this.probe(url);
    const normalizedUrl = requestUrl(url);
    const requirement = challenge.accepts.find((candidate) =>
      this.#policy.allowedNetworks.includes(candidate.network),
    );
    if (requirement === undefined) {
      throw new PolicyDenied(
        "POL-NETWORK",
        "No offered payment requirement uses an allowed network",
      );
    }

    const intent = paymentIntentFromRequirement(
      requirement,
      challenge.resource.url,
    );
    const intentHash = hashIntent(intent);
    const decision = evaluate(
      intent,
      this.#policy,
      this.#window.spentInWindow(this.#now()),
      this.#now(),
    );
    throwIfDenied(decision);

    if (decision.outcome === "approval_required") {
      const approval = await this.#approver.approve(intent, intentHash);
      if (!approval.approved) {
        throw new ApprovalDenied(approval.reason);
      }

      const currentDecision = evaluate(
        intent,
        this.#policy,
        this.#window.spentInWindow(this.#now()),
        this.#now(),
      );
      throwIfDenied(currentDecision);
    }

    this.#reservationSequence += 1;
    const reservationId = `${this.#reservationNamespace}:${intentHash}:${this.#reservationSequence}`;
    this.#window.reserve(
      reservationId,
      intent.amountUnits,
      this.#now(),
      intentHash,
    );
    let signatureTransmitted = false;

    try {
      const { transaction } = await this.#signer.sign(intent);
      await this.#signer.verifyBinding(transaction, intent);

      const signature = encodePaymentPayload({
        x402Version: X402_VERSION,
        resource: challenge.resource,
        accepted: requirement,
        payload: { transaction },
      });
      // Make the debit non-expiring before the transport can receive the
      // signature; an in-flight request may outlive the rolling window.
      this.#window.markIndeterminate(reservationId);
      // From this point onward, any failure is ambiguous: the signed payment
      // may settle even if no response arrives.
      signatureTransmitted = true;
      const response = await this.#fetchLike(normalizedUrl, {
        method: "GET",
        redirect: REDIRECT_POLICY,
        headers: {
          [HEADERS.paymentSignature]: signature,
        },
      });
      assertResponseUrl(response, normalizedUrl);
      if (response.status < 200 || response.status >= 300) {
        throw new UpstreamFailed(response.status);
      }

      const encodedSettlement = response.headers.get(HEADERS.paymentResponse);
      if (encodedSettlement === null) {
        throw new WireError("Successful response is missing PAYMENT-RESPONSE");
      }
      const settlement = decodeSettlementResponse(encodedSettlement);
      if (!settlement.success) {
        throw new WireError("Facilitator reported an unsuccessful settlement");
      }
      if (settlement.network !== intent.network) {
        throw new WireError("Settlement network differs from the approved intent");
      }
      if (settlement.payer !== this.#signer.address()) {
        throw new WireError("Settlement payer differs from the configured signer");
      }

      const body = await response.text();
      const result = Object.freeze({
        status: response.status,
        body,
        settlement,
        intentHash,
        amountUnits: intent.amountUnits,
      });
      this.#window.commit(reservationId);
      return result;
    } catch (error) {
      if (!signatureTransmitted) {
        this.#window.release(reservationId);
        throw error;
      }

      const contextualError = withTransmissionContext(error, intentHash);
      try {
        this.#window.markIndeterminate(reservationId);
      } catch (storeError) {
        throw withTransmissionContext(
          new X402KitError(
            "Payment outcome is indeterminate but the window store could not record it",
            { cause: new AggregateError([contextualError, storeError]) },
          ),
          intentHash,
        );
      }
      throw contextualError;
    }
  }
}
