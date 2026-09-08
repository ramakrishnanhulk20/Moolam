// Covers environment parsing: defaults, and every failure naming its variable.
// Does NOT cover reading the repo .env file, which the module does at import
// time on a real boot.

import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  it("fills in the defaults when nothing is set", () => {
    const parsed = parseEnv({});
    expect(parsed.VERIFIER_PORT).toBe(4000);
    expect(parsed.PASSPORT_SOURCE).toBe("json");
    expect(parsed.PASSPORT_SOURCE_PATH.length).toBeGreaterThan(0);
  });

  it("names VERIFIER_PORT when the port is not a number", () => {
    expect(() => parseEnv({ VERIFIER_PORT: "abc" })).toThrow(/VERIFIER_PORT/);
    expect(() => parseEnv({ VERIFIER_PORT: "70000" })).toThrow(/VERIFIER_PORT/);
    expect(() => parseEnv({ VERIFIER_PORT: "" })).toThrow(/VERIFIER_PORT/);
  });

  it("names PASSPORT_SOURCE when the source is unknown", () => {
    expect(() => parseEnv({ PASSPORT_SOURCE: "postgres" })).toThrow(/PASSPORT_SOURCE/);
  });

  it("names PASSPORT_SOURCE_PATH when the json source has no path", () => {
    expect(() => parseEnv({ PASSPORT_SOURCE: "json", PASSPORT_SOURCE_PATH: "  " })).toThrow(/PASSPORT_SOURCE_PATH/);
  });

  it("accepts envio only with an endpoint to read", () => {
    expect(() => parseEnv({ PASSPORT_SOURCE: "envio" })).toThrow(/ENVIO_GRAPHQL_URL/);
    const parsed = parseEnv({ PASSPORT_SOURCE: "envio", ENVIO_GRAPHQL_URL: "https://indexer.envio.dev/v1/graphql" });
    expect(parsed.PASSPORT_SOURCE).toBe("envio");
    expect(parsed.ENVIO_GRAPHQL_URL).toBe("https://indexer.envio.dev/v1/graphql");
  });

  it("names ENVIO_GRAPHQL_URL when it is not an http URL", () => {
    expect(() => parseEnv({ PASSPORT_SOURCE: "envio", ENVIO_GRAPHQL_URL: "indexer.envio.dev" })).toThrow(
      /ENVIO_GRAPHQL_URL/,
    );
  });

  it("takes the C2PA certificate and key as a pair or not at all", () => {
    expect(() => parseEnv({ MOOLAM_C2PA_CERT_PATH: "certs/chain.pem" })).toThrow(/go together/);
    expect(() => parseEnv({ MOOLAM_C2PA_KEY_PATH: "certs/signer.key.pem" })).toThrow(/go together/);

    const both = parseEnv({ MOOLAM_C2PA_CERT_PATH: "certs/chain.pem", MOOLAM_C2PA_KEY_PATH: "certs/signer.key.pem" });
    expect(both.MOOLAM_C2PA_CERT_PATH).toBe("certs/chain.pem");
    expect(parseEnv({ MOOLAM_C2PA_CERT_PATH: "  " }).MOOLAM_C2PA_CERT_PATH).toBeUndefined();
  });
});
