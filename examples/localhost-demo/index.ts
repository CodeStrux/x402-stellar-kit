import { once } from "node:events";
import { createServer } from "node:http";

import {
  AutoApprover,
  BindingDrift,
  HEADERS,
  MemoryWindowStore,
  MockFacilitator,
  MockSigner,
  NETWORKS,
  Payer,
  PolicyDenied,
  createResourceServer,
  decodePaymentRequired,
  evaluate,
  intentHash,
  paymentIntentFromRequirement,
  type ApprovalResult,
  type Approver,
  type PaymentIntent,
  type PaymentRequired,
  type PolicyConfig,
  type ResourceResult,
  type Signer,
} from "../../src/index.js";

const PAYER = "GDENLOVXZTJXN7B62BPJBCCKGZ37JC6TFJWZTDYBIH3HVWA3RZ73UR4Z";
const PAYEE = "GDWT3YRVK73LUUBIGHEY7BKNO3HHLOARAQLJTP62NSLAJWMXPSKNVTVU";
const OTHER_PAYEE = NETWORKS.testnet.usdcIssuer;
const ASSET = NETWORKS.testnet.usdcContract;
const NETWORK = NETWORKS.testnet.caip2;

const print = (label: string, value: unknown): void => {
  console.log(
    `${label}\n${JSON.stringify(
      value,
      (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      2,
    )}`,
  );
};

class RecordingApprover implements Approver {
  result: ApprovalResult | undefined;
  readonly #delegate = new AutoApprover();

  async approve(
    intent: PaymentIntent,
    challengeHash: string,
  ): Promise<ApprovalResult> {
    this.result = await this.#delegate.approve(intent, challengeHash);
    return this.result;
  }
}

const sendResult = (
  result: ResourceResult,
  response: import("node:http").ServerResponse,
): void => {
  if (result.kind === "challenge") {
    response.writeHead(result.status, result.headers);
    response.end("payment required");
    return;
  }
  if (result.kind === "paid") {
    response.writeHead(result.status, {
      ...result.headers,
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ message: "offline paid resource" }));
    return;
  }
  response.writeHead(result.status, { "content-type": "text/plain" });
  response.end(result.reason);
};

const main = async (): Promise<void> => {
  console.log(
    "[demo] network=stellar:testnet (offline) facilitator=MockFacilitator",
  );
  const facilitator = new MockFacilitator(PAYER);
  facilitator.credit(PAYER, 50_000_000n);
  const routes = new Map<
    string,
    ReturnType<typeof createResourceServer>
  >();
  const signedRequests = new Map<string, number>();
  let baseUrl = "";

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", baseUrl);
      const route = routes.get(url.pathname);
      if (route === undefined) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(",") : value;
      }
      if (headers[HEADERS.paymentSignature.toLowerCase()] !== undefined) {
        signedRequests.set(
          url.pathname,
          (signedRequests.get(url.pathname) ?? 0) + 1,
        );
      }

      sendResult(
        await route.handle({
          method: request.method ?? "GET",
          url: url.toString(),
          headers,
        }),
        response,
      );
    } catch (error) {
      response.writeHead(500);
      response.end(error instanceof Error ? error.message : "unknown error");
    }
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");

  try {
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine demo server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const addRoute = (path: string, price: string, payTo: string): void => {
      routes.set(
        path,
        createResourceServer({
          price,
          payTo,
          asset: ASSET,
          network: NETWORK,
          facilitator,
          resource: {
            url: `${baseUrl}${path}`,
            description: "Offline x402 teaching resource",
            mimeType: "application/json",
          },
        }),
      );
    };

    addRoute("/paid", "0.01", PAYEE);
    addRoute("/over-cap", "1", PAYEE);
    addRoute("/wrong-payee", "0.01", OTHER_PAYEE);
    addRoute("/tampered", "0.01", PAYEE);

    const policy: PolicyConfig = {
      allowedNetworks: [NETWORK],
      originAllowlist: [baseUrl],
      payToAllowlist: [PAYEE],
      assetAllowlist: [ASSET],
      maxPaymentUnits: 1_000_000n,
      windowCapUnits: 20_000_000n,
      windowSeconds: 3_600,
      maxTimeoutSeconds: 60,
      autoApproveMaxUnits: 0n,
    };
    const signer = new MockSigner(PAYER);
    const approver = new RecordingApprover();
    let challenge: PaymentRequired | undefined;
    const recordingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      const encoded = response.headers.get(HEADERS.paymentRequired);
      if (response.status === 402 && encoded !== null) {
        challenge = decodePaymentRequired(encoded);
      }
      return response;
    };
    const payer = new Payer({
      signer,
      approver,
      policy,
      window: new MemoryWindowStore(policy.windowSeconds),
      fetchLike: recordingFetch,
    });
    const paid = await payer.pay(`${baseUrl}/paid`);

    if (challenge === undefined) {
      throw new Error("Demo did not capture a payment challenge");
    }
    const selected = challenge.accepts[0];
    const intent = paymentIntentFromRequirement(selected, challenge.resource.url);
    const challengeHash = intentHash(intent);
    const decision = evaluate(intent, policy, 0n, Date.now());

    print("1. Decoded PAYMENT-REQUIRED challenge", challenge);
    print("2. Payment intent and intentHash", {
      ...intent,
      intentHash: challengeHash,
    });
    print("3. Policy decision", decision);
    print("4. Approval outcome", approver.result);
    print("5. Settlement and final response", {
      transaction: paid.settlement.transaction,
      status: paid.status,
      body: paid.body,
    });

    const refusalPolicy: PolicyConfig = {
      ...policy,
      autoApproveMaxUnits: 100_000n,
    };

    for (const [label, path, expected] of [
      ["Over per-payment cap", "/over-cap", "POL-MAX"],
      ["Non-allowlisted payee", "/wrong-payee", "POL-PAYTO"],
    ] as const) {
      try {
        await new Payer({ signer, policy: refusalPolicy }).pay(`${baseUrl}${path}`);
        throw new Error(`${label} was unexpectedly paid`);
      } catch (error) {
        if (!(error instanceof PolicyDenied) || error.code !== expected) {
          throw error;
        }
        console.log(`Refusal — ${label}: ${error.code}`);
      }
    }

    const tamperingSigner: Signer = {
      address: () => signer.address(),
      sign: async (approvedIntent) =>
        signer.sign({
          ...approvedIntent,
          amountUnits: approvedIntent.amountUnits + 1n,
        }),
      verifyBinding: (transaction, approvedIntent) =>
        signer.verifyBinding(transaction, approvedIntent),
    };
    const before = signedRequests.get("/tampered") ?? 0;
    try {
      await new Payer({ signer: tamperingSigner, policy: refusalPolicy }).pay(
        `${baseUrl}/tampered`,
      );
      throw new Error("Tampered intent was unexpectedly paid");
    } catch (error) {
      if (!(error instanceof BindingDrift)) {
        throw error;
      }
      console.log(`Refusal — Tampered intent: ${error.code}`);
    }
    const after = signedRequests.get("/tampered") ?? 0;
    const transmitted = after !== before;
    console.log(`Tampered signature transmitted: ${transmitted ? "yes" : "no"}`);
    if (transmitted) {
      throw new Error("Binding drift reached the resource server");
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
};

await main();
