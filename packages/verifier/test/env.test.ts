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

  it("accepts envio as a reserved source name", () => {
    expect(parseEnv({ PASSPORT_SOURCE: "envio" }).PASSPORT_SOURCE).toBe("envio");
  });
});
