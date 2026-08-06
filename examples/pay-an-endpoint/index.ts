import {
  AutoApprover,
  MockFacilitator,
  MockSigner,
  Payer,
  PromptApprover,
  createResourceServer,
  type PolicyConfig,
  type ResourceResult,
} from "../../src/index.js";

const resourceUrl = "https://example.test/report";
const payerAddress = "payer-example";
const payeeAddress = "payee-example";
const asset = "asset-example";
const network = "stellar:testnet";
const facilitator = new MockFacilitator(payerAddress);
facilitator.credit(payerAddress, 1_000_000n);

const server = createResourceServer({
  price: "0.01",
  payTo: payeeAddress,
  asset,
  network,
  facilitator,
  resource: { url: resourceUrl, description: "Offline paid report" },
});

const asResponse = (result: ResourceResult): Response => {
  if (result.kind === "rejected") {
    return new Response(result.reason, { status: result.status });
  }
  return new Response(
    result.kind === "paid" ? JSON.stringify({ message: "paid report" }) : "payment required",
    { status: result.status, headers: result.headers },
  );
};

const fetchLike: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  return asResponse(
    await server.handle({
      method: request.method,
      url: request.url,
      headers: request.headers,
    }),
  );
};

const policy: PolicyConfig = {
  allowedNetworks: [network],
  originAllowlist: [new URL(resourceUrl).origin],
  payToAllowlist: [payeeAddress],
  assetAllowlist: [asset],
  maxPaymentUnits: 200_000n,
  windowCapUnits: 1_000_000n,
  windowSeconds: 3_600,
  maxTimeoutSeconds: 60,
  autoApproveMaxUnits: 0n,
};

// PromptApprover is for a watched terminal; AutoApprover is for unattended
// operation where the deterministic policy is the complete spending boundary.
const approver = process.stdin.isTTY ? new PromptApprover() : new AutoApprover();
const payer = new Payer({
  signer: new MockSigner(payerAddress),
  policy,
  approver,
  fetchLike,
});
const result = await payer.pay(resourceUrl);

console.log(`intent hash: ${result.intentHash}`);
console.log(`tx hash: ${result.settlement.transaction}`);
