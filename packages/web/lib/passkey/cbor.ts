import type { Hex } from "viem";
import { pointToCoordinates } from "./spki";

/**
 * How deep a value may nest. An attestation object is a map holding a map and
 * a byte string, three levels at the very most. Anything deeper is somebody
 * handing this decoder a few kilobytes of opening brackets to see whether the
 * recursion blows the stack, which it would.
 */
const MAX_DEPTH = 8;

/** The COSE key is not the P-256 key the registry stores, so nothing may be bound from it. */
export class WrongCurve extends Error {
  constructor(detail: string) {
    super(`this passkey is not a P-256 key the registry can hold: ${detail}`);
    this.name = "WrongCurve";
  }
}

/** The CBOR nests further than an attestation object ever does. */
export class CborTooDeep extends Error {
  constructor() {
    super(`this CBOR nests deeper than ${MAX_DEPTH} levels, which no attestation object does`);
    this.name = "CborTooDeep";
  }
}

/**
 * Enough CBOR to read a WebAuthn attestation object: unsigned and negative
 * integers, byte strings, text strings, arrays and maps. Indefinite lengths,
 * tags, floats and simple values are refused, because an authenticator never
 * sends them here and a decoder that guesses at them is a decoder that can be
 * fed something surprising.
 *
 * Maps come back as a Map so the COSE key's negative integer keys survive,
 * which a plain object would turn into strings.
 */
export function decodeCbor(bytes: Uint8Array): unknown {
  const reader = { bytes, offset: 0 };
  const value = readValue(reader, 0);
  if (reader.offset !== bytes.length) {
    throw new Error("the CBOR value is followed by bytes that are not part of it");
  }
  return value;
}

/**
 * Digs the public key out of an attestation object.
 *
 * This is the fallback for browsers whose credential has no getPublicKey().
 * The path is: the attestation map's authData byte string, then past the 32
 * byte relying party hash, the flags byte and the 4 byte counter, then the 16
 * byte AAGUID and the 2 byte credential id length, then the credential id, and
 * what is left is the COSE key whose -2 and -3 entries are x and y.
 *
 * Throws when any of those pieces is missing or the wrong size.
 */
export function attestationToPoint(attestationObject: Uint8Array): { qx: Hex; qy: Hex } {
  const attestation = decodeCbor(attestationObject);
  if (!(attestation instanceof Map)) {
    throw new Error("the attestation object is not a CBOR map");
  }

  const authData = attestation.get("authData");
  if (!(authData instanceof Uint8Array)) {
    throw new Error("the attestation object carries no authData");
  }
  if (authData.length < 55) {
    throw new Error("authData is too short to hold a credential");
  }

  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const credentialIdLength = view.getUint16(53, false);
  const keyStart = 55 + credentialIdLength;
  if (keyStart > authData.length) {
    throw new Error("the credential id runs past the end of authData");
  }

  const reader = { bytes: authData, offset: keyStart };
  const coseKey = readValue(reader, 0);
  if (!(coseKey instanceof Map)) {
    throw new Error("the credential public key is not a CBOR map");
  }

  // kty 2 is EC2, alg -7 is ES256 and crv 1 is P-256. All three are checked
  // before x and y are read, because a secp256k1 key carries coordinates of
  // exactly the same size: without this the registry would be handed 64 bytes
  // that look right and belong to a curve it cannot verify against.
  const kty = coseKey.get(1);
  const alg = coseKey.get(3);
  const crv = coseKey.get(-1);
  if (kty !== 2) {
    throw new WrongCurve(`its key type is ${String(kty)} rather than the elliptic curve type 2`);
  }
  if (alg !== -7) {
    throw new WrongCurve(`it signs with algorithm ${String(alg)} rather than ES256`);
  }
  if (crv !== 1) {
    throw new WrongCurve(`it sits on curve ${String(crv)} rather than P-256`);
  }

  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) {
    throw new Error("the credential public key has no P-256 coordinates");
  }

  return pointToCoordinates(x, y);
}

interface Reader {
  bytes: Uint8Array;
  offset: number;
}

function readValue(reader: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new CborTooDeep();
  }

  const initial = readByte(reader);
  const major = initial >> 5;
  const argument = readArgument(reader, initial & 0x1f);

  if (major === 0) {
    return toNumber(argument);
  }
  if (major === 1) {
    return -1 - toNumber(argument);
  }
  if (major === 2) {
    return readBytes(reader, toNumber(argument));
  }
  if (major === 3) {
    return new TextDecoder("utf-8", { fatal: true }).decode(readBytes(reader, toNumber(argument)));
  }
  if (major === 4) {
    const length = toNumber(argument);
    const items: unknown[] = [];
    for (let i = 0; i < length; i += 1) {
      items.push(readValue(reader, depth + 1));
    }
    return items;
  }
  if (major === 5) {
    const length = toNumber(argument);
    const map = new Map<number | string, unknown>();
    for (let i = 0; i < length; i += 1) {
      const key = readValue(reader, depth + 1);
      if (typeof key !== "number" && typeof key !== "string") {
        throw new Error("this decoder only reads maps keyed by integers or text");
      }
      map.set(key, readValue(reader, depth + 1));
    }
    return map;
  }

  throw new Error(`CBOR major type ${major} is not something an attestation object should contain`);
}

function readArgument(reader: Reader, info: number): bigint {
  if (info < 24) {
    return BigInt(info);
  }
  if (info === 24) {
    return BigInt(readByte(reader));
  }
  if (info === 25 || info === 26 || info === 27) {
    const width = info === 25 ? 2 : info === 26 ? 4 : 8;
    let value = 0n;
    for (const byte of readBytes(reader, width)) {
      value = (value << 8n) | BigInt(byte);
    }
    return value;
  }
  throw new Error("indefinite length CBOR is not supported here");
}

function readByte(reader: Reader): number {
  if (reader.offset >= reader.bytes.length) {
    throw new Error("the CBOR value ends before it is complete");
  }
  const byte = reader.bytes[reader.offset];
  reader.offset += 1;
  return byte;
}

function readBytes(reader: Reader, length: number): Uint8Array {
  const end = reader.offset + length;
  if (end > reader.bytes.length) {
    throw new Error("the CBOR value ends before it is complete");
  }
  const slice = reader.bytes.subarray(reader.offset, end);
  reader.offset = end;
  return slice;
}

function toNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("that CBOR length is larger than anything an attestation object holds");
  }
  return Number(value);
}
