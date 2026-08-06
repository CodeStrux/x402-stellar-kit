const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PUBLIC_KEY_VERSION_BYTE = 6 << 3;
const CONTRACT_VERSION_BYTE = 2 << 3;
const SUPPORTED_VERSION_BYTES = new Set([
  PUBLIC_KEY_VERSION_BYTE,
  CONTRACT_VERSION_BYTE,
]);
const STRKEY_LENGTH = 56;
const PAYLOAD_LENGTH = 32;

const crc16XModem = (bytes: Uint8Array): number => {
  let crc = 0;

  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }

  return crc;
};

const encodeBase32 = (bytes: Uint8Array): string => {
  let output = "";
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1;
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return output;
};

const decodeBase32 = (value: string): Uint8Array => {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of value) {
    const decoded = BASE32_ALPHABET.indexOf(character);
    if (decoded < 0) {
      throw new Error("Invalid base32 character");
    }

    buffer = (buffer << 5) | decoded;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }

  if (bits > 0 && buffer !== 0) {
    throw new Error("Invalid base32 padding bits");
  }

  return Uint8Array.from(bytes);
};

export const encodeStrkey = (
  versionByte: number,
  payload: Uint8Array,
): string => {
  if (!Number.isInteger(versionByte) || versionByte < 0 || versionByte > 0xff) {
    throw new TypeError("Invalid strkey version byte");
  }
  if (payload.length !== PAYLOAD_LENGTH) {
    throw new Error("Invalid strkey payload length");
  }

  const body = new Uint8Array(1 + payload.length);
  body[0] = versionByte;
  body.set(payload, 1);
  const checksum = crc16XModem(body);
  const encoded = new Uint8Array(body.length + 2);
  encoded.set(body);
  encoded[body.length] = checksum & 0xff;
  encoded[body.length + 1] = checksum >> 8;
  return encodeBase32(encoded);
};

export const decodeStrkey = (
  value: string,
): { versionByte: number; payload: Uint8Array } => {
  if (typeof value !== "string" || value.length !== STRKEY_LENGTH) {
    throw new Error("Invalid strkey length");
  }

  const decoded = decodeBase32(value);
  if (decoded.length !== 1 + PAYLOAD_LENGTH + 2) {
    throw new Error("Invalid strkey length");
  }

  const body = decoded.subarray(0, decoded.length - 2);
  const expected = crc16XModem(body);
  const actual = decoded[decoded.length - 2] | (decoded[decoded.length - 1] << 8);
  if (actual !== expected) {
    throw new Error("Invalid strkey checksum");
  }

  const versionByte = body[0];
  if (!SUPPORTED_VERSION_BYTES.has(versionByte)) {
    throw new Error("Unsupported strkey version byte");
  }

  return {
    versionByte,
    payload: body.slice(1),
  };
};

const isValidVersion = (value: string, versionByte: number): boolean => {
  try {
    return decodeStrkey(value).versionByte === versionByte;
  } catch {
    return false;
  }
};

export const isValidEd25519PublicKey = (value: string): boolean =>
  value.startsWith("G") &&
  value.length === STRKEY_LENGTH &&
  isValidVersion(value, PUBLIC_KEY_VERSION_BYTE);

export const isValidContractId = (value: string): boolean =>
  value.startsWith("C") &&
  value.length === STRKEY_LENGTH &&
  isValidVersion(value, CONTRACT_VERSION_BYTE);
