import { Hono } from "hono";

import { HEADERS, MockFacilitator } from "../../src/index.js";
import { x402Hono } from "../../src/server/adapters/hono.js";

const resourceUrl = "http://localhost/paid";
const facilitator = new MockFacilitator("payer-example");
facilitator.credit("payer-example", 1_000_000n);

export const app = new Hono();

app.get("/health", (context) => context.json({ ok: true }));
app.get(
  "/paid",
  x402Hono({
    price: "0.01",
    payTo: "payee-example",
    asset: "asset-example",
    network: "stellar:testnet",
    facilitator,
    resource: { url: resourceUrl, description: "Paid example data" },
  }),
  (context) => context.json({ message: "paid data" }),
);

const response = await app.request(resourceUrl);
console.log(`charge-my-api status: ${response.status}`);
console.log(
  `PAYMENT-REQUIRED: ${response.headers.has(HEADERS.paymentRequired) ? "present" : "missing"}`,
);
