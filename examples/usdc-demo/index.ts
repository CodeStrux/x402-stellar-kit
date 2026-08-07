import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

import {
  Account,
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-base";

import {
  BindingDrift,
  HEADERS,
  HttpFacilitator,
  NETWORKS,
  Payer,
  StellarRpc,
  StellarSigner,
  createResourceServer,
  fundWithFriendbot,
  generateKeypair,
  parseUnits,
  type PolicyConfig,
  type ResourceResult,
  type Signer,
} from "../../src/index.js";

const PAYMENT_UNITS = 100_000n;
const DEFAULT_FACILITATOR = "https://channels.openzeppelin.com/x402/testnet";

type HorizonBalance = Readonly<{
  asset_type?: unknown;
  asset_code?: unknown;
  asset_issuer?: unknown;
  balance?: unknown;
}>;

const fetchJson = async (url: string | URL, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).origin}`);
  }
  return (await response.json()) as unknown;
};

const accountRecord = async (address: string): Promise<Record<string, unknown>> => {
  const value = await fetchJson(
    `${NETWORKS.testnet.horizonUrl}/accounts/${encodeURIComponent(address)}`,
  );
  if (value === null || typeof value !== "object") {
    throw new Error("Horizon returned malformed account data");
  }
  return value as Record<string, unknown>;
};

const payerHasUsdc = async (
  address: string,
): Promise<{ trustline: boolean; enough: boolean }> => {
  let account: Record<string, unknown>;
  try {
    account = await accountRecord(address);
  } catch {
    return { trustline: false, enough: false };
  }
  if (!Array.isArray(account.balances)) {
    throw new Error("Horizon account balances were malformed");
  }
  const balance = (account.balances as HorizonBalance[]).find(
    (candidate) =>
      candidate.asset_code === "USDC" &&
      candidate.asset_issuer === NETWORKS.testnet.usdcIssuer,
  );
  if (balance === undefined || typeof balance.balance !== "string") {
    return { trustline: false, enough: false };
  }
  return {
    trustline: true,
    enough: parseUnits(balance.balance) >= PAYMENT_UNITS,
  };
};

const printFundingInstructions = (
  address: string,
  state: { trustline: boolean; enough: boolean },
): void => {
  console.error(`Payer address: ${address}`);
  if (!state.trustline) {
    console.error(
      `1. Add a Stellar testnet trustline for USDC:${NETWORKS.testnet.usdcIssuer} to this address (Stellar Lab: https://lab.stellar.org/account/fund?network=test).`,
    );
  }
  console.error(
    `${state.trustline ? "1" : "2"}. Open https://faucet.circle.com/, select Stellar and Testnet, paste ${address}, and request testnet USDC.`,
  );
  console.error(
    "Then rerun npm run demo:usdc with the same process-supplied payer secret.",
  );
};

const establishUsdcTrustline = async (
  merchant: ReturnType<typeof generateKeypair>,
): Promise<void> => {
  // No stellar-sdk: these are the small Horizon load/submit calls needed for
  // the one classic changeTrust transaction.
  const account = await accountRecord(merchant.publicKey());
  if (typeof account.sequence !== "string" || !/^\d+$/.test(account.sequence)) {
    throw new Error("Horizon merchant sequence was malformed");
  }
  const asset = new Asset("USDC", NETWORKS.testnet.usdcIssuer);
  const transaction = new TransactionBuilder(
    new Account(merchant.publicKey(), account.sequence),
    {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.networkPassphrase,
    },
  )
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  transaction.sign(merchant);
  await fetchJson(`${NETWORKS.testnet.horizonUrl}/transactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: transaction.toXDR() }),
  });
};

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
    const body = JSON.stringify({ message: "USDC-gated testnet resource" });
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
  console.log("[demo:usdc] network=stellar:testnet facilitator=HttpFacilitator");
  const seed = process.env.X402_STELLAR_SECRET;
  if (seed === undefined || seed.length === 0) {
    console.error(
      "X402_STELLAR_SECRET is required in the process environment; do not write it to a file.",
    );
    process.exitCode = 1;
    return;
  }
  const rpc = new StellarRpc(NETWORKS.testnet.rpcUrl);
  const stellarSigner = StellarSigner.fromSecret(seed, { rpc });
  const payerState = await payerHasUsdc(stellarSigner.address());
  if (!payerState.trustline || !payerState.enough) {
    printFundingInstructions(stellarSigner.address(), payerState);
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env.X402_FACILITATOR_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    console.error(
      "X402_FACILITATOR_API_KEY is required. Generate a testnet key at https://channels.openzeppelin.com/testnet/gen and pass it only in the process environment.",
    );
    process.exitCode = 1;
    return;
  }

  const merchant = generateKeypair();
  await fundWithFriendbot(merchant.publicKey());
  await establishUsdcTrustline(merchant);
  const facilitator = new HttpFacilitator({
    baseUrl: process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR,
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: 30_000,
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
          asset: NETWORKS.testnet.usdcContract,
          network: NETWORKS.testnet.caip2,
          facilitator,
          resource: {
            url: `${baseUrl}${path}`,
            description: "Live USDC testnet resource",
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
      assetAllowlist: [NETWORKS.testnet.usdcContract],
      maxPaymentUnits: 1_000_000n,
      windowCapUnits: 2_000_000n,
      windowSeconds: 3_600,
      maxTimeoutSeconds: 60,
      autoApproveMaxUnits: 1_000_000n,
    };
    let approvedXdr = "";
    const recordingSigner: Signer = {
      address: () => stellarSigner.address(),
      sign: async (intent) => {
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
    if (approvedXdr.length === 0) throw new Error("Demo did not capture XDR");
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
      if (after !== before) throw new Error("Binding drift was transmitted");
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
  console.error(
    `[demo:usdc] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
