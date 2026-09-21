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

  it("names MONAD_RPC_FALLBACK_URL when it is not an http URL, without printing what was set", () => {
    const wrong = "busy.example/TOKEN-THAT-MUST-NOT-BE-PRINTED";

    const thrown = (() => {
      try {
        parseEnv({ MONAD_RPC_FALLBACK_URL: wrong });
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(thrown?.message).toMatch(/MONAD_RPC_FALLBACK_URL/);
    expect(thrown?.message).not.toContain("TOKEN-THAT-MUST-NOT-BE-PRINTED");
    expect(parseEnv({}).MONAD_RPC_FALLBACK_URL).toBe("https://rpc.monad.xyz");
    expect(parseEnv({ MONAD_RPC_FALLBACK_URL: "  " }).MONAD_RPC_FALLBACK_URL).toBe("https://rpc.monad.xyz");
  });

  it("defaults the three ceilings for everyone and takes zero as a closed route", () => {
    const parsed = parseEnv({});
    expect(parsed.GLOBAL_PREPARES_PER_DAY).toBe(300);
    expect(parsed.GLOBAL_GENERATIONS_PER_DAY).toBe(60);
    expect(parsed.GLOBAL_EDITS_PER_DAY).toBe(150);

    // Zero is the kill switch: a legal value that shuts one route for everyone without a deploy.
    expect(parseEnv({ GLOBAL_GENERATIONS_PER_DAY: "0" }).GLOBAL_GENERATIONS_PER_DAY).toBe(0);
    expect(parseEnv({ GLOBAL_EDITS_PER_DAY: "  " }).GLOBAL_EDITS_PER_DAY).toBe(150);
  });

  it("stops the boot on a ceiling that is not a whole number, without printing what was set", () => {
    const wrong = "sixty-THAT-MUST-NOT-BE-PRINTED";

    const thrown = (() => {
      try {
        parseEnv({ GLOBAL_GENERATIONS_PER_DAY: wrong });
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();

    expect(thrown?.message).toMatch(/GLOBAL_GENERATIONS_PER_DAY/);
    expect(thrown?.message).not.toContain("THAT-MUST-NOT-BE-PRINTED");
    expect(() => parseEnv({ GLOBAL_PREPARES_PER_DAY: "-1" })).toThrow(/GLOBAL_PREPARES_PER_DAY/);
    expect(() => parseEnv({ GLOBAL_PREPARES_PER_DAY: "12.5" })).toThrow(/GLOBAL_PREPARES_PER_DAY/);
    expect(() => parseEnv({ GLOBAL_EDITS_PER_DAY: "1000000" })).toThrow(/GLOBAL_EDITS_PER_DAY/);
  });

  it("takes the C2PA certificate and key as a pair or not at all", () => {
    expect(() => parseEnv({ MOOLAM_C2PA_CERT_PATH: "certs/chain.pem" })).toThrow(/go together/);
    expect(() => parseEnv({ MOOLAM_C2PA_KEY_PATH: "certs/signer.key.pem" })).toThrow(/go together/);

    const both = parseEnv({ MOOLAM_C2PA_CERT_PATH: "certs/chain.pem", MOOLAM_C2PA_KEY_PATH: "certs/signer.key.pem" });
    expect(both.MOOLAM_C2PA_CERT_PATH).toBe("certs/chain.pem");
    expect(parseEnv({ MOOLAM_C2PA_CERT_PATH: "  " }).MOOLAM_C2PA_CERT_PATH).toBeUndefined();
  });
});
