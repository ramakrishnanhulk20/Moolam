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

/** Pinata's public gateway. An account's own dedicated gateway is preferred when .env names one. */
const DEFAULT_PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs/";

/**
 * The deployed Moolam registry on Monad mainnet, from
 * packages/contracts/deployments/monad-mainnet.json. The container ships only this package's
 * source, so the address cannot be read from that file at runtime; it is the EIP-712 domain the
 * generator agent signs against, and a redeploy is the one thing that changes it.
 */
const DEFAULT_MOOLAM_REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0";

/** The ERC-8004 identity the generator agent owns, minted by the Privy proof. */
const DEFAULT_GENERATOR_AGENT_ID = "10249";

/**
 * How many pictures one signed-in creator may have drawn a day. Three is about 9 cents of image
 * model spend per creator, which is what keeps a public route off the OpenAI key and the Pinata
 * plan.
 */
const DEFAULT_GENERATE_PER_DAY = "3";

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
    PINATA_JWT: z
      .string()
      .trim()
      .optional()
      .refine((value) => value === undefined || value.length === 0 || value.length >= 20, {
        message: "PINATA_JWT is too short to be a Pinata API token",
      })
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
    PINATA_GATEWAY_URL: z
      .string()
      .trim()
      .default("")
      .refine((value) => value.length === 0 || isHttpUrl(value), {
        message: "PINATA_GATEWAY_URL must be an absolute http or https URL",
      })
      .transform((value) => (value.length === 0 ? DEFAULT_PINATA_GATEWAY : value)),
    PRIVY_APP_ID: optionalPattern(
      /^[a-z0-9]{20,32}$/i,
      "PRIVY_APP_ID must be the 20 to 32 character app id from the Privy dashboard",
    ),
    PRIVY_APP_SECRET: optionalText(),
    PRIVY_AUTHORIZATION_KEY: optionalText(),
    OPENAI_API_KEY: optionalMinLength(20, "OPENAI_API_KEY is too short to be an OpenAI API key"),
    OPENROUTER_API_KEY: optionalMinLength(
      20,
      "OPENROUTER_API_KEY is too short to be an OpenRouter API key",
    ),
    AGENT_IMAGE_MODEL: optionalText(),
    AGENT_IMAGE_BASE_URL: z
      .string()
      .trim()
      .optional()
      .refine((value) => value === undefined || value.length === 0 || isHttpUrl(value), {
        message: "AGENT_IMAGE_BASE_URL must be an absolute http or https URL",
      })
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
    GENERATOR_WALLET_ID: optionalText(),
    GENERATOR_WALLET_ADDRESS: optionalPattern(
      /^0x[0-9a-fA-F]{40}$/,
      "GENERATOR_WALLET_ADDRESS must be 0x followed by 40 hex characters",
    ),
    GENERATOR_AGENT_ID: z
      .string()
      .trim()
      .default(DEFAULT_GENERATOR_AGENT_ID)
      .transform((value, ctx) => {
        const text = value.length === 0 ? DEFAULT_GENERATOR_AGENT_ID : value;
        if (!/^[0-9]+$/.test(text) || BigInt(text) === 0n) {
          ctx.addIssue({ code: "custom", message: "GENERATOR_AGENT_ID must be a positive whole number" });
          return z.NEVER;
        }
        return BigInt(text);
      }),
    GENERATE_PER_DAY: z
      .string()
      .trim()
      .default(DEFAULT_GENERATE_PER_DAY)
      .transform((value, ctx) => {
        const count = Number(value.length === 0 ? DEFAULT_GENERATE_PER_DAY : value);
        if (!Number.isInteger(count) || count < 1 || count > 1000) {
          ctx.addIssue({
            code: "custom",
            message: "GENERATE_PER_DAY must be a whole number between 1 and 1000",
          });
          return z.NEVER;
        }
        return count;
      }),
    MOOLAM_REGISTRY_ADDRESS: z
      .string()
      .trim()
      .default(DEFAULT_MOOLAM_REGISTRY)
      .transform((value) => (value.length === 0 ? DEFAULT_MOOLAM_REGISTRY : value))
      .refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value), {
        message: "MOOLAM_REGISTRY_ADDRESS must be 0x followed by 40 hex characters",
      }),
    CORS_ORIGINS: z
      .string()
      .trim()
      .default("")
      .transform((value, ctx) => {
        const origins = value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        for (const origin of origins) {
          if (!isExactOrigin(origin)) {
            ctx.addIssue({
              code: "custom",
              message: `CORS_ORIGINS must be a comma separated list of exact origins such as https://moolam.app, and "${origin}" is not one`,
            });
            return z.NEVER;
          }
        }
        return origins;
      }),
    PRIVY_JWKS_OVERRIDE_PATH: optionalText(),
    NODE_ENV: optionalText(),
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
    if (value.PRIVY_JWKS_OVERRIDE_PATH !== undefined && value.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["PRIVY_JWKS_OVERRIDE_PATH"],
        message:
          "PRIVY_JWKS_OVERRIDE_PATH is for local tests only and is refused when NODE_ENV is production, because it would let anyone holding that key sign tokens this service accepts",
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

/** An optional secret that is only checked for being long enough to be the real thing. */
function optionalMinLength(length: number, message: string): z.ZodType<string | undefined> {
  return z
    .string()
    .trim()
    .optional()
    .refine((value) => value === undefined || value.length === 0 || value.length >= length, { message })
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

/**
 * True for an origin the browser would send in an Origin header: scheme, host, optional port, and
 * nothing else. A wildcard, a path or a trailing slash is refused, because CORS here is the list
 * of sites allowed to spend Ram's Pinata account.
 */
function isExactOrigin(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }
  const parsed = new URL(value);
  return parsed.origin === value && !value.includes("*");
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
    PINATA_JWT: source.PINATA_JWT,
    PINATA_GATEWAY_URL: source.PINATA_GATEWAY_URL,
    PRIVY_APP_ID: source.PRIVY_APP_ID,
    PRIVY_APP_SECRET: source.PRIVY_APP_SECRET,
    PRIVY_AUTHORIZATION_KEY: source.PRIVY_AUTHORIZATION_KEY,
    OPENAI_API_KEY: source.OPENAI_API_KEY,
    OPENROUTER_API_KEY: source.OPENROUTER_API_KEY,
    AGENT_IMAGE_MODEL: source.AGENT_IMAGE_MODEL,
    AGENT_IMAGE_BASE_URL: source.AGENT_IMAGE_BASE_URL,
    GENERATOR_WALLET_ID: source.GENERATOR_WALLET_ID,
    GENERATOR_WALLET_ADDRESS: source.GENERATOR_WALLET_ADDRESS,
    GENERATOR_AGENT_ID: source.GENERATOR_AGENT_ID,
    GENERATE_PER_DAY: source.GENERATE_PER_DAY,
    MOOLAM_REGISTRY_ADDRESS: source.MOOLAM_REGISTRY_ADDRESS,
    CORS_ORIGINS: source.CORS_ORIGINS,
    PRIVY_JWKS_OVERRIDE_PATH: source.PRIVY_JWKS_OVERRIDE_PATH,
    NODE_ENV: source.NODE_ENV,
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
