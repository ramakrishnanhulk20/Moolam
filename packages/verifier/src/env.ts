import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 20 MB. Big enough for a camera original, small enough that a flood cannot exhaust memory. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** How long a server-side fetch of a remote image may take before it is abandoned. */
export const FETCH_TIMEOUT_MS = 10_000;
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

/**
 * Where the dev passport file lands. The spike writes it next to the images it
 * generates, in the gitignored test-assets folder, so a fresh clone can start
 * the service and get a real answer without hand-editing anything.
 */
const DEFAULT_PASSPORT_PATH = path.join(PACKAGE_ROOT, "test-assets", "passports.json");

/** Monad's own public endpoint, so a read works before anyone signs up for a provider. */
const DEFAULT_MONAD_RPC_URL = "https://rpc.monad.xyz";

/** The facilitator Monad runs for x402 on mainnet. */
const DEFAULT_FACILITATOR_URL = "https://x402-facilitator.molandak.org";

const DEFAULT_X402_PRICE = "$0.05";

// Shell variables win over the file, so a one-off VERIFIER_PORT=... still bites.
const repoEnvFile = path.join(REPO_ROOT, ".env");
if (existsSync(repoEnvFile)) {
  try {
    process.loadEnvFile(repoEnvFile);
  } catch {
    // A malformed .env should not stop the service; the schema below still runs
    // and will name whatever is missing.
  }
}

const schema = z
  .object({
    VERIFIER_PORT: z
      .string()
      .default("4000")
      .transform((value, ctx) => {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          ctx.addIssue({ code: "custom", message: "VERIFIER_PORT must be a whole number between 1 and 65535" });
          return z.NEVER;
        }
        return port;
      }),
    PASSPORT_SOURCE: z.enum(["json", "envio"], {
      error: "PASSPORT_SOURCE must be \"json\" or \"envio\"",
    }).default("json"),
    PASSPORT_SOURCE_PATH: z.string().default(DEFAULT_PASSPORT_PATH),
    ENVIO_GRAPHQL_URL: z
      .string()
      .trim()
      .optional()
      .refine((value) => value === undefined || value.length === 0 || isHttpUrl(value), {
        message: "ENVIO_GRAPHQL_URL must be an absolute http or https URL",
      })
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
    MOOLAM_C2PA_CERT_PATH: optionalText(),
    MOOLAM_C2PA_KEY_PATH: optionalText(),
    MONAD_MAINNET_RPC_URL: z
      .string()
      .trim()
      .default(DEFAULT_MONAD_RPC_URL)
      .refine(isHttpUrl, { message: "MONAD_MAINNET_RPC_URL must be an absolute http or https URL" }),
    VERIFIER_PRIVATE_KEY: optionalPattern(
      /^0x[0-9a-fA-F]{64}$/,
      "VERIFIER_PRIVATE_KEY must be 0x followed by 64 hex characters",
    ),
    VERIFIER_ADDRESS: optionalPattern(
      /^0x[0-9a-fA-F]{40}$/,
      "VERIFIER_ADDRESS must be 0x followed by 40 hex characters",
    ),
    VERIFIER_BASE_URL: z
      .string()
      .trim()
      .default("")
      .refine((value) => value.length === 0 || isHttpUrl(value), {
        message: "VERIFIER_BASE_URL must be an absolute http or https URL",
      }),
    X402_ENABLED: z
      .enum(["true", "false"], { error: "X402_ENABLED must be \"true\" or \"false\"" })
      .default("false")
      .transform((value) => value === "true"),
    X402_FACILITATOR_URL: z
      .string()
      .trim()
      .default(DEFAULT_FACILITATOR_URL)
      .refine(isHttpUrl, { message: "X402_FACILITATOR_URL must be an absolute http or https URL" }),
    X402_PAY_TO_ADDRESS: optionalPattern(
      /^0x[0-9a-fA-F]{40}$/,
      "X402_PAY_TO_ADDRESS must be 0x followed by 40 hex characters",
    ),
    X402_PRICE: z
      .string()
      .trim()
      .default(DEFAULT_X402_PRICE)
      .refine((value) => /^\$[0-9]+(\.[0-9]{1,6})?$/.test(value), {
        message: "X402_PRICE must be a dollar amount such as $0.05",
      }),
  })
  .superRefine((value, ctx) => {
    if (value.PASSPORT_SOURCE === "json" && value.PASSPORT_SOURCE_PATH.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["PASSPORT_SOURCE_PATH"],
        message: "PASSPORT_SOURCE_PATH is required when PASSPORT_SOURCE is \"json\"",
      });
    }
    if (value.PASSPORT_SOURCE === "envio" && value.ENVIO_GRAPHQL_URL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["ENVIO_GRAPHQL_URL"],
        message: "ENVIO_GRAPHQL_URL is required when PASSPORT_SOURCE is \"envio\"",
      });
    }
    if ((value.MOOLAM_C2PA_CERT_PATH === undefined) !== (value.MOOLAM_C2PA_KEY_PATH === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["MOOLAM_C2PA_CERT_PATH"],
        message:
          "MOOLAM_C2PA_CERT_PATH and MOOLAM_C2PA_KEY_PATH go together: set both to sign with your own identity, or neither to use the development one",
      });
    }
    if (value.X402_ENABLED && value.X402_PAY_TO_ADDRESS === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["X402_PAY_TO_ADDRESS"],
        message: "X402_PAY_TO_ADDRESS is required when X402_ENABLED is true",
      });
    }
  });

/** An optional value where a blank line in .env means the same as no line at all. */
function optionalText(): z.ZodType<string | undefined> {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value.length === 0 ? undefined : value));
}

/** An optional string that must match `pattern` when it is present and not blank. */
function optionalPattern(pattern: RegExp, message: string): z.ZodType<string | undefined> {
  return z
    .string()
    .trim()
    .optional()
    .refine((value) => value === undefined || value.length === 0 || pattern.test(value), { message })
    .transform((value) => (value === undefined || value.length === 0 ? undefined : value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof schema>;

/**
 * Reads and validates the environment.
 *
 * Every failure message names the variable that caused it, so a bad boot says
 * which line of .env to fix instead of printing a schema dump.
 *
 * Throws when any variable is missing or invalid.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse({
    VERIFIER_PORT: source.VERIFIER_PORT,
    PASSPORT_SOURCE: source.PASSPORT_SOURCE,
    PASSPORT_SOURCE_PATH: source.PASSPORT_SOURCE_PATH,
    ENVIO_GRAPHQL_URL: source.ENVIO_GRAPHQL_URL,
    MOOLAM_C2PA_CERT_PATH: source.MOOLAM_C2PA_CERT_PATH,
    MOOLAM_C2PA_KEY_PATH: source.MOOLAM_C2PA_KEY_PATH,
    MONAD_MAINNET_RPC_URL: source.MONAD_MAINNET_RPC_URL,
    VERIFIER_PRIVATE_KEY: source.VERIFIER_PRIVATE_KEY,
    VERIFIER_ADDRESS: source.VERIFIER_ADDRESS,
    VERIFIER_BASE_URL: source.VERIFIER_BASE_URL,
    X402_ENABLED: source.X402_ENABLED,
    X402_FACILITATOR_URL: source.X402_FACILITATOR_URL,
    X402_PAY_TO_ADDRESS: source.X402_PAY_TO_ADDRESS,
    X402_PRICE: source.X402_PRICE,
  });

  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path[0];
      const named = typeof name === "string" && issue.message.includes(name);
      return named || typeof name !== "string" ? issue.message : `${name}: ${issue.message}`;
    });
    throw new Error(`environment is not usable: ${lines.join("; ")}`);
  }

  return result.data;
}

/** The parsed environment, validated once at import time so a bad boot fails loudly. */
export const env: Env = parseEnv();
