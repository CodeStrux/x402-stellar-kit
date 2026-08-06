import type {
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
  VerifyResponse,
} from "../wire.js";

export interface Facilitator {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse>;
}
