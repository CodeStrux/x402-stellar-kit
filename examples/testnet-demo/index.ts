import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

import {
  BindingDrift,
  HEADERS,
  LocalFacilitator,
  NETWORKS,
  Payer,
  StellarRpc,
  StellarSigner,
  TESTNET_DEMO_TRANSFER_LIMITS,
  createResourceServer,
  deploySacFor,
  fundWithFriendbot,
  generateKeypair,
  issueDemoAsset,
  type PaymentIntent,
  type PolicyConfig,
  type ResourceResult,
  type Signer,
} from "../../src/index.js";
import { isTransientNetworkFailure } from "../../src/network-error.js";

const send = async (
  result: ResourceResult,
  response: ServerResponse,
): Promise<void> => {
  if (result.kind === "challenge") {
    response.writeHead(result.status, result.headers);
    response.end("payment required");
    return;
  }
  if (result.kind === "verified") {
    // Produce the resource FIRST, settle only once it exists. Settling before
    // the handler charges the payer for responses they never receive.
    const body = JSON.stringify({ message: "PLAY-gated testnet resource" });
    const settled = await result.settle();
    if (settled.kind === "rejected") {
      response.writeHead(settled.status, { "content-type": "text/plain" });
      response.end(settled.reason);
      return;
    }
    response.writeHead(settled.status, {
      ...settled.headers,
      "content-type": "application/json",
    });
    response.end(body);
    return;
  }
  response.writeHead(result.status, { "content-type": "text/plain" });
  response.end(result.reason);
};

const main = async (): Promise<void> => {
  console.log("[demo:testnet] network=stellar:testnet facilitator=LocalFacilitator");
  const issuer = generateKeypair();
  const merchant = generateKeypair();
  const payerKeypair = generateKeypair();

  for (const keypair of [issuer, merchant, payerKeypair]) {
    await fundWithFriendbot(keypair.publicKey());
  }
  const issued = await issueDemoAsset({
    code: "PLAY",
    issuer,
    recipient: payerKeypair,
    trustlineRecipients: [merchant],
    amount: "100",
  });
  const rpc = new StellarRpc(NETWORKS.testnet.rpcUrl);
  const sac = await deploySacFor(issued.asset, issuer, { rpc });
  const facilitator = new LocalFacilitator({
    rpc,
    sourceKeypair: issuer,
    resourceLimits: TESTNET_DEMO_TRANSFER_LIMITS,
    settlementTimeoutMs: 90_000,
  });

  const routes = new Map<string, ReturnType<typeof createResourceServer>>();
  const signedRequests = new Map<string, number>();
  let baseUrl = "";
  const server = createServer(async (request, response) => {
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
      await send(
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not determine demo server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    const addRoute = (path: string, price: string): void => {
      routes.set(
        path,
        createResourceServer({
          price,
          payTo: merchant.publicKey(),
          asset: sac,
          network: NETWORKS.testnet.caip2,
          facilitator,
          resource: {
            url: `${baseUrl}${path}`,
            description: "Live PLAY testnet resource",
            mimeType: "application/json",
          },
        }),
      );
    };
    addRoute("/premium", "0.01");
    addRoute("/mutated", "0.02");

    const policy: PolicyConfig = {
      allowedNetworks: [NETWORKS.testnet.caip2],
      originAllowlist: [baseUrl],
      payToAllowlist: [merchant.publicKey()],
      assetAllowlist: [sac],
      maxPaymentUnits: 1_000_000n,
      windowCapUnits: 2_000_000n,
      windowSeconds: 3_600,
      maxTimeoutSeconds: 60,
      autoApproveMaxUnits: 1_000_000n,
    };
    const stellarSigner = StellarSigner.fromSecret(payerKeypair.secret(), { rpc });
    let approvedIntent: PaymentIntent | undefined;
    let approvedXdr = "";
    const recordingSigner: Signer = {
      address: () => stellarSigner.address(),
      sign: async (intent) => {
        approvedIntent = intent;
        const signed = await stellarSigner.sign(intent);
        approvedXdr = signed.transaction;
        return signed;
      },
      verifyBinding: (transaction, intent) =>
        stellarSigner.verifyBinding(transaction, intent),
    };
    const paid = await new Payer({ signer: recordingSigner, policy }).pay(
      `${baseUrl}/premium`,
    );
    if (approvedIntent === undefined || approvedXdr.length === 0) {
      throw new Error("Demo did not capture the approved transaction");
    }

    console.log(`intent hash: ${paid.intentHash}`);
    console.log(`XDR: ${approvedXdr}`);
    console.log(`settled tx hash: ${paid.settlement.transaction}`);
    console.log(
      `explorer: https://stellar.expert/explorer/testnet/tx/${paid.settlement.transaction}`,
    );

    const replaySigner: Signer = {
      address: () => stellarSigner.address(),
      sign: async () => ({ transaction: approvedXdr }),
      verifyBinding: (transaction, intent) =>
        stellarSigner.verifyBinding(transaction, intent),
    };
    const before = signedRequests.get("/mutated") ?? 0;
    try {
      await new Payer({ signer: replaySigner, policy }).pay(`${baseUrl}/mutated`);
      throw new Error("Mutated approval was unexpectedly transmitted");
    } catch (error) {
      if (!(error instanceof BindingDrift)) throw error;
      const after = signedRequests.get("/mutated") ?? 0;
      console.log(
        `mutated approval: ${error.code}; transmitted=${after === before ? "no" : "yes"}`,
      );
      if (after !== before) {
        throw new Error("Binding drift reached the resource server");
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
};

try {
  await main();
} catch (error) {
  const kind = isTransientNetworkFailure(error) ? "environment/network" : "code";
  console.error(
    `[demo:testnet] FAILED (${kind}): ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
