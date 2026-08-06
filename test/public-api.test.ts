import { describe, expect, it } from "vitest";

import * as kit from "../src/index.js";

describe("public package surface", () => {
  it("exports the offline core seams from one entrypoint", () => {
    expect(kit).toMatchObject({
      X402_VERSION: 2,
      Payer: expect.any(Function),
      MockSigner: expect.any(Function),
      MockFacilitator: expect.any(Function),
      HttpFacilitator: expect.any(Function),
      LocalFacilitator: expect.any(Function),
      StellarRpc: expect.any(Function),
      StellarSigner: expect.any(Function),
      verifyStellarBinding: expect.any(Function),
      verifyBinding: expect.any(Function),
      generateKeypair: expect.any(Function),
      fundWithFriendbot: expect.any(Function),
      issueDemoAsset: expect.any(Function),
      deploySacFor: expect.any(Function),
      MemoryWindowStore: expect.any(Function),
      createResourceServer: expect.any(Function),
      evaluate: expect.any(Function),
    });
  });
});
