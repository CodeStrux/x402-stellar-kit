/**
 * An approver runs only after policy returns `approval_required`. Its answer
 * can only narrow, never widen, a policy decision. Callers must never invoke
 * an approver for a payment that policy denied.
 */

import { createInterface } from "node:readline/promises";

import { canonicalJson, type PaymentIntent } from "../intent.js";

export type ApprovalResult =
  | { approved: true; evidence: Readonly<Record<string, unknown>> }
  | { approved: false; reason: string };

export interface Approver {
  approve(intent: PaymentIntent, intentHash: string): Promise<ApprovalResult>;
}

export class DenyAllApprover implements Approver {
  async approve(
    _intent: PaymentIntent,
    _intentHash: string,
  ): Promise<ApprovalResult> {
    return {
      approved: false,
      reason: "No payment approver was configured",
    };
  }
}

export class AutoApprover implements Approver {
  async approve(
    _intent: PaymentIntent,
    intentHash: string,
  ): Promise<ApprovalResult> {
    return {
      approved: true,
      evidence: Object.freeze({ approver: "auto", intentHash }),
    };
  }
}

export class PromptApprover implements Approver {
  async approve(
    intent: PaymentIntent,
    intentHash: string,
  ): Promise<ApprovalResult> {
    if (process.stdin.isTTY !== true) {
      return {
        approved: false,
        reason: "Interactive approval requires a TTY",
      };
    }

    process.stderr.write(
      `Payment intent:\n${canonicalJson(intent)}\nIntent hash: ${intentHash}\n`,
    );
    const prompt = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    try {
      const answer = (await prompt.question("Approve payment? [y/N] "))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") {
        return {
          approved: true,
          evidence: Object.freeze({ approver: "prompt", intentHash }),
        };
      }
      return { approved: false, reason: "Operator declined payment" };
    } finally {
      prompt.close();
    }
  }
}
