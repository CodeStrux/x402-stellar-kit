# x402 V2 golden fixtures

These are the **conformance oracle** for the wire codec. They were captured from real settlements
on Stellar testnet against a public x402 facilitator — not hand-written from the spec — so they
encode what the wire actually looks like, including the parts the prose is vague about.

## What tests must assert

- `decode(<name>.encoded.txt)` **deep-equals** `<name>.decoded.json`.
- `encode(decoded)` must `decode` back to a deep-equal object.
- **Never byte-compare encodings.** JSON key order is not part of the contract.
- `payload.transaction` is an **opaque base64 XDR string** to everyone except the payer's
  pre-send binding check. Do not parse it in wire tests.

## Files

| Fixture | Shape |
|---|---|
| `payment-required.*` | the `PAYMENT-REQUIRED` header payload — a 402 challenge. Note the live server sends `error: "Payment required"` and omits top-level `extensions`. |
| `payment-payload.*` | the `PAYMENT-SIGNATURE` header payload — a signed envelope |
| `settlement-response.*` | the `PAYMENT-RESPONSE` header payload |
| `verify-request` / `settle-request` | facilitator request bodies. Envelope is `{x402Version, paymentPayload, paymentRequirements}`, where `paymentRequirements` is **the single chosen requirement**, not the array. |
| `verify-response-ok` / `settle-response` | facilitator responses — `{isValid, payer}` / `{success, transaction, network, payer}` |
| `verify-response-fail` | **synthetic**, spec-derived. No live failure has been captured. It is also unknown whether a failed `/settle` omits `transaction`; the schema currently requires it. |

## Provenance and what was modified

Captured from two real testnet settlements, `$0.01` each, fees sponsored:

```
ac5799ca408015bbe0bb735be46aa75052fb25d69c57925f581c154941b71ab5
84bec78e335e4c462adfbb78ff8973d1ecd846a756cc7c3186ab7e39c02c5432
```

Every `payload.transaction` XDR blob is **byte-identical to the captured original** — the hard part
to fabricate is genuine.

One change was made: the `resource.description` string was replaced with a neutral one before
publication. Because the `.encoded.txt` files are base64 of that JSON, those three were
regenerated from the edited objects, and each was verified to round-trip. Everything else —
amounts, assets, addresses, timeouts, `extra.areFeesSponsored`, envelope shapes — is as captured.

Stellar addresses in these files are **public ledger data**. There is no secret material here.
