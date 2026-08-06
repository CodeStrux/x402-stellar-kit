export type NetworkConstants = Readonly<{
  caip2: string;
  networkPassphrase: string;
  usdcIssuer: string;
  usdcContract: string;
  horizonUrl: string;
  rpcUrl: string;
  friendbotUrl: string;
}>;

const deepFreeze = <T extends object>(value: T): T => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }

  return Object.freeze(value);
};

export const NETWORKS: Readonly<{
  testnet: NetworkConstants;
  pubnet: NetworkConstants;
}> = deepFreeze({
  testnet: {
    caip2: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    usdcContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    friendbotUrl: "https://friendbot.stellar.org",
  },
  pubnet: {
    caip2: "stellar:pubnet",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    usdcContract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "",
    friendbotUrl: "",
  },
});

export const X402_VERSION = 2 as const;
export const DECIMALS = 7 as const;

export const HEADERS = deepFreeze({
  paymentRequired: "PAYMENT-REQUIRED",
  paymentSignature: "PAYMENT-SIGNATURE",
  paymentResponse: "PAYMENT-RESPONSE",
} as const);

const BASE_UNIT_SCALE = 10n ** BigInt(DECIMALS);

export const parseUnits = (decimal: string): bigint => {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal);
  if (match === null) {
    throw new TypeError("Invalid decimal amount");
  }

  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(DECIMALS, "0");
  return whole * BASE_UNIT_SCALE + BigInt(fraction || "0");
};

export const formatUnits = (units: bigint): string => {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / BASE_UNIT_SCALE;
  const fraction = (absolute % BASE_UNIT_SCALE)
    .toString()
    .padStart(DECIMALS, "0")
    .replace(/0+$/, "");
  const value = fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${value}` : value;
};
