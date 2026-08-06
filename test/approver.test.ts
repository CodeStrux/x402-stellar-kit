import { describe, expect, it } from "vitest";

import {
  AutoApprover,
  DenyAllApprover,
  PromptApprover,
} from "../src/approver/index.js";
import type { PaymentIntent } from "../src/intent.js";

const intent: PaymentIntent = {
  network: "stellar:testnet",
  scheme: "exact",
  asset: "asset-a",
  payTo: "payee-a",
  amountUnits: 10n,
  resourceUrl: "https://example.test/data",
  maxTimeoutSeconds: 60,
};

describe("approvers", () => {
  it("defaults to an explicit denial", async () => {
    await expect(new DenyAllApprover().approve(intent, "hash")).resolves.toEqual({
      approved: false,
      reason: "No payment approver was configured",
    });
  });

  it("auto-approval returns auditable evidence", async () => {
    await expect(new AutoApprover().approve(intent, "hash")).resolves.toEqual({
      approved: true,
      evidence: { approver: "auto", intentHash: "hash" },
    });
  });

  it("prompt approval denies without reading non-TTY stdin", async () => {
    if (process.stdin.isTTY) {
      return;
    }

    await expect(new PromptApprover().approve(intent, "hash")).resolves.toEqual({
      approved: false,
      reason: "Interactive approval requires a TTY",
    });
  });
});
