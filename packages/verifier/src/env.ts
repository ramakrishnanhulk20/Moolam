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

/**
 * Monad's own public endpoint, so a read works before anyone signs up for a provider. It is also
 * what sits behind a dedicated endpoint when one is configured, which is why the same address is
 * the default for both RPC variables.
 */
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

/**
 * MoolamConsent on Monad mainnet, from the same deployments file: deployed in block 105828247 and
 * verified through Sourcify. It is where /verify reads what a picture's holder said about AI use.
 * Like the registry above, the container ships only this package's source, so the address is held
 * here rather than read from the contracts package at runtime.
 */
const DEFAULT_MOOLAM_CONSENT = "0x1151E69a82947920546e779c4C8c785b2a3C1277";

/** The ERC-8004 identity the generator agent owns, minted by the Privy proof. */
const DEFAULT_GENERATOR_AGENT_ID = "10249";

/**
 * How many edits one signed-in creator may append a day. Every edit spends four pins and gas
 * Privy sponsors, so this is what stops one account draining both.
 */
const DEFAULT_EDITS_PER_DAY = "5";

/**
 * How many pictures one signed-in creator may have drawn a day. Three is about 9 cents of image
 * model spend per creator, which is what keeps a public route off the OpenAI key and the Pinata
 * plan.
 */
const DEFAULT_GENERATE_PER_DAY = "3";

/**
 * What the whole world may spend in a UTC day, per action.
 *
 * Every other limit is per Privy user id and accounts are free, so these are the only numbers that
 * bound what ten throwaway accounts can cost. 300 prepares is about 1,200 Pinata pins and 300
 * sponsored registers, roughly 11 MON at Monad's 100 gwei floor; 60 generations is about two
 * dollars of image model spend; 150 edits is about 4.5 MON of sponsored gas and 600 pins.
 */
const DEFAULT_GLOBAL_PREPARES_PER_DAY = "300";
const DEFAULT_GLOBAL_GENERATIONS_PER_DAY = "60";
const DEFAULT_GLOBAL_EDITS_PER_DAY = "150";

/**
 * Unsealing is the rarest thing this service does and the most expensive per call: it pins a whole
 * picture, its thumbnail, its manifest and the record, and the picture can be 20 MB. Fifty is far
 * more than a judging fortnight needs and about 200 pins at the ceiling.
 */
const DEFAULT_GLOBAL_UNSEALS_PER_DAY = "50";

/**
 * Read links to private copies the whole service may mint in a UTC day (B15). A re-check run needs
 * one, so a hundred is far past what the runner's own daily budget can use, and zero switches
 * /sealed/link off for everyone like every other ceiling here.
 */
const DEFAULT_GLOBAL_LINKS_PER_DAY = "100";

/**
 * What the platform routes let one platform key, and every platform together, prepare. Sized for
 * the demo platform's ten pictures with a wide margin, and far under the studio's own 300 a day,
 * since each prepare costs a C2PA signing and four pins. Zero closes platform prepares, like every
 * other ceiling here.
 */
const DEFAULT_PLATFORM_PREPARES_PER_KEY_PER_DAY = "100";
const DEFAULT_GLOBAL_PLATFORM_PREPARES_PER_DAY = "500";

/**
 * What GET /claims, accept and refuse may cost together in one UTC day, for everyone. Each lookup
 * is one Privy user read and up to a page of gateway reads, so this bounds what free accounts can
 * spend of both. Zero closes the three routes, like every other ceiling here.
 */
const DEFAULT_CLAIM_REQUESTS_PER_DAY = "20000";

/**
 * How many pictures the web check may send to Google Cloud Vision in a UTC day, for everyone. The
 * first 1,000 a month are free and each one after costs about a third of a cent, so 300 a day keeps
 * a month near 30 dollars at worst. Zero switches the web check off without a deploy.
 */
const DEFAULT_VISION_CHECKS_PER_DAY = "300";

/**
 * What the hourly sweep of orphaned private copies does: nothing, log what it would delete, or
 * delete. Dry is the default so a new host only logs until an operator has read a few runs and
 * switches it on (ruling D5).
 */
export const PRIVATE_SWEEP_MODES = ["off", "dry", "delete"] as const;

export type PrivateSweepMode = (typeof PRIVATE_SWEEP_MODES)[number];

/**
 * Where the service keeps what it must remember when neither DATA_DIR nor a Railway volume names a
 * folder: the gitignored test-assets folder, so a fresh clone can run the service without a setup
 * step. Inside the container this is part of the image's own disk, which a redeploy replaces.
 */
const DEFAULT_DATA_DIR = path.join(PACKAGE_ROOT, "test-assets", "state");

/** Where a host's DATA_DIR came from, so the boot can say when state will not outlive a deploy. */
export type DataDirSource = "DATA_DIR" | "RAILWAY_VOLUME_MOUNT_PATH" | "default";

/**
 * How often the passport index is rebuilt from the source. A minute is well inside the time it
 * takes a creator to register an image and then go and verify it, and a rebuild of a few thousand
 * records costs milliseconds.
 */
const DEFAULT_INDEX_REFRESH_MS = 60_000;

/**
 * How long a verification waits for a free matching slot before the caller is told the service is
 * busy. Thirty seconds is far longer than a match takes, so reaching it means a real queue.
 */
const DEFAULT_MATCH_WAIT_MS = 30_000;

/** The routes a host can insist on in EXPECT_ROUTES. /verify and /health are always mounted. */
export const EXPECTABLE_ROUTES = ["prepare", "generate", "edit", "verify/paid"] as const;

export type ExpectedRoute = (typeof EXPECTABLE_ROUTES)[number];

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
    MONAD_RPC_FALLBACK_URL: z
      .string()
      .trim()
      .default(DEFAULT_MONAD_RPC_URL)
      .transform((value) => (value.length === 0 ? DEFAULT_MONAD_RPC_URL : value))
      .refine(isHttpUrl, { message: "MONAD_RPC_FALLBACK_URL must be an absolute http or https URL" }),
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
    PRIVY_EDIT_SIGNER_ID: optionalPattern(
      /^[a-z0-9]{20,32}$/i,
      "PRIVY_EDIT_SIGNER_ID must be the key quorum id from the Privy dashboard, 20 to 32 characters",
    ),
    PRIVY_EDIT_POLICY_ID: optionalPattern(
      /^[a-z0-9]{20,32}$/i,
      "PRIVY_EDIT_POLICY_ID must be the policy id from the Privy dashboard, 20 to 32 characters",
    ),
    EDITS_PER_DAY: z
      .string()
      .trim()
      .default(DEFAULT_EDITS_PER_DAY)
      .transform((value, ctx) => {
        const count = Number(value.length === 0 ? DEFAULT_EDITS_PER_DAY : value);
        if (!Number.isInteger(count) || count < 1 || count > 1000) {
          ctx.addIssue({
            code: "custom",
            message: "EDITS_PER_DAY must be a whole number between 1 and 1000",
          });
          return z.NEVER;
        }
        return count;
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
    GLOBAL_PREPARES_PER_DAY: dayCeiling("GLOBAL_PREPARES_PER_DAY", DEFAULT_GLOBAL_PREPARES_PER_DAY),
    GLOBAL_GENERATIONS_PER_DAY: dayCeiling("GLOBAL_GENERATIONS_PER_DAY", DEFAULT_GLOBAL_GENERATIONS_PER_DAY),
    GLOBAL_EDITS_PER_DAY: dayCeiling("GLOBAL_EDITS_PER_DAY", DEFAULT_GLOBAL_EDITS_PER_DAY),
    GLOBAL_UNSEALS_PER_DAY: dayCeiling("GLOBAL_UNSEALS_PER_DAY", DEFAULT_GLOBAL_UNSEALS_PER_DAY),
    GLOBAL_LINKS_PER_DAY: dayCeiling("GLOBAL_LINKS_PER_DAY", DEFAULT_GLOBAL_LINKS_PER_DAY),
    PLATFORM_PREPARES_PER_KEY_PER_DAY: dayCeiling("PLATFORM_PREPARES_PER_KEY_PER_DAY", DEFAULT_PLATFORM_PREPARES_PER_KEY_PER_DAY),
    GLOBAL_PLATFORM_PREPARES_PER_DAY: dayCeiling("GLOBAL_PLATFORM_PREPARES_PER_DAY", DEFAULT_GLOBAL_PLATFORM_PREPARES_PER_DAY),
    PRIVATE_SWEEP: z
      .string()
      .trim()
      .default("dry")
      .transform((value) => (value.length === 0 ? "dry" : value))
      .pipe(z.enum(PRIVATE_SWEEP_MODES, { error: 'PRIVATE_SWEEP must be "off", "dry" or "delete"' })),
    RUNNER_TOKEN: optionalMinLength(
      24,
      "RUNNER_TOKEN must be at least 24 characters: it is the only thing between a stranger and the re-check queue",
    ),
    SEALED_LINK_TOKEN: optionalMinLength(
      24,
      "SEALED_LINK_TOKEN must be at least 24 characters: with a passport id it mints a read link to that passport's private copy",
    ),
    DATA_DIR: absoluteFolder("DATA_DIR"),
    RAILWAY_VOLUME_MOUNT_PATH: absoluteFolder("RAILWAY_VOLUME_MOUNT_PATH"),
    RECHECK_QUEUE_PATH: optionalText(),
    MOOLAM_REGISTRY_ADDRESS: z
      .string()
      .trim()
      .default(DEFAULT_MOOLAM_REGISTRY)
      .transform((value) => (value.length === 0 ? DEFAULT_MOOLAM_REGISTRY : value))
      .refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value), {
        message: "MOOLAM_REGISTRY_ADDRESS must be 0x followed by 40 hex characters",
      }),
    CONSENT_ADDRESS: z
      .string()
      .trim()
      .default(DEFAULT_MOOLAM_CONSENT)
      .transform((value) => (value.length === 0 ? DEFAULT_MOOLAM_CONSENT : value))
      .refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value), {
        message: "CONSENT_ADDRESS must be 0x followed by 40 hex characters",
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
              message: `CORS_ORIGINS must be a comma separated list of exact origins such as https://moolam.site, and "${origin}" is not one`,
            });
            return z.NEVER;
          }
        }
        return origins;
      }),
    TRUST_PROXY: z.string().trim().default(""),
    INDEX_REFRESH_MS: milliseconds("INDEX_REFRESH_MS", DEFAULT_INDEX_REFRESH_MS, 0),
    MATCH_WAIT_MS: milliseconds("MATCH_WAIT_MS", DEFAULT_MATCH_WAIT_MS, 1),
    EXPECT_ROUTES: z
      .string()
      .trim()
      .default("")
      .transform((value, ctx) => {
        const names = value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        for (const name of names) {
          if (!(EXPECTABLE_ROUTES as readonly string[]).includes(name)) {
            ctx.addIssue({
              code: "custom",
              message: `EXPECT_ROUTES must be a comma separated list of ${EXPECTABLE_ROUTES.join(", ")}, and "${name}" is not one`,
            });
            return z.NEVER;
          }
        }
        return names as ExpectedRoute[];
      }),
    PRIVY_JWKS_OVERRIDE_PATH: optionalText(),
    CLAIM_PEPPER: optionalPattern(
      /^(?:[0-9a-fA-F]{2}){32,128}$/,
      "CLAIM_PEPPER must be 64 to 256 hex characters, at least 32 bytes from a CSPRNG such as `openssl rand -hex 32`",
    ),
    CLAIM_PEPPER_VERSION: optionalPattern(
      /^[1-9][0-9]{0,8}$/,
      "CLAIM_PEPPER_VERSION must be a whole number from 1, raised by one on every new CLAIM_PEPPER",
    ),
    CLAIM_REQUESTS_PER_DAY: dayCeiling("CLAIM_REQUESTS_PER_DAY", DEFAULT_CLAIM_REQUESTS_PER_DAY),
    NETWORK_ACTIVATION_TIME: optionalUnixSeconds("NETWORK_ACTIVATION_TIME"),
    LOOKALIKE_RECEIVER: optionalPattern(
      /^0x(?!0{40}$)[0-9a-fA-F]{40}$/,
      "LOOKALIKE_RECEIVER must be MoolamLookalikes' address, 0x followed by 40 hex characters and not the zero address",
    ).transform((value) => value?.toLowerCase()),
    // Held to the characters a Google API key is made of, so nothing that could break out of the
    // header it travels in can be set here. The message never repeats the value.
    GOOGLE_VISION_API_KEY: optionalPattern(
      /^[A-Za-z0-9_-]{20,200}$/,
      "GOOGLE_VISION_API_KEY must be a Google Cloud API key: 20 to 200 letters, digits, dashes or underscores",
    ),
    VISION_CHECKS_PER_DAY: dayCeiling("VISION_CHECKS_PER_DAY", DEFAULT_VISION_CHECKS_PER_DAY),
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
    // The runtime image carries no passport file and a missing one loads as an empty list, so a
    // production host on the json default would call every picture unregistered while /health said
    // it was fine (review pass 10, V102). Unset reads as json here, so both are refused.
    if (value.NODE_ENV === "production" && value.PASSPORT_SOURCE === "json") {
      ctx.addIssue({
        code: "custom",
        path: ["PASSPORT_SOURCE"],
        message:
          "PASSPORT_SOURCE must be \"envio\" when NODE_ENV is production: the json source reads a local file the deployed image does not hold, and an empty register would call every picture unregistered",
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
    // A version with no pepper, or a pepper with no version, would hash emails under a tag that
    // does not say which secret made them, so rotation could not tell old tickets from new.
    if ((value.CLAIM_PEPPER === undefined) !== (value.CLAIM_PEPPER_VERSION === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["CLAIM_PEPPER"],
        message: "CLAIM_PEPPER and CLAIM_PEPPER_VERSION go together: set both to open the claim routes, or neither to keep them closed",
      });
    }
    if (value.X402_ENABLED && value.X402_PAY_TO_ADDRESS === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["X402_PAY_TO_ADDRESS"],
        message: "X402_PAY_TO_ADDRESS is required when X402_ENABLED is true",
      });
    }
  })
  .transform(({ RAILWAY_VOLUME_MOUNT_PATH, ...value }) => {
    // The container's start script picks the folder to hand to the node user by this same order,
    // DATA_DIR first and then the volume Railway mounted, so the folder it prepares is the folder
    // this process writes to.
    const DATA_DIR_SOURCE: DataDirSource =
      value.DATA_DIR !== undefined ? "DATA_DIR" : RAILWAY_VOLUME_MOUNT_PATH !== undefined ? "RAILWAY_VOLUME_MOUNT_PATH" : "default";
    const DATA_DIR = value.DATA_DIR ?? RAILWAY_VOLUME_MOUNT_PATH ?? DEFAULT_DATA_DIR;
    return {
      ...value,
      DATA_DIR,
      DATA_DIR_SOURCE,
      RECHECK_QUEUE_PATH: value.RECHECK_QUEUE_PATH ?? path.join(DATA_DIR, "recheck-queue.json"),
    };
  });

/**
 * An optional folder that has to be an absolute path exactly as written.
 *
 * Only the empty string means unset, and a value with spaces around it is refused rather than
 * trimmed, because the start script reads the same variable in sh without trimming it: a value the
 * two read differently would hand one folder to the node user and write to another.
 */
function absoluteFolder(name: string): z.ZodType<string | undefined> {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.length === 0) {
        return undefined;
      }
      if (value !== value.trim() || !path.isAbsolute(value)) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be an absolute path with no spaces around it, such as /data`,
        });
        return z.NEVER;
      }
      return value;
    });
}

/**
 * A day's ceiling for everyone, where zero closes the action rather than meaning "no limit".
 *
 * Zero is the kill switch the operator can flip on Railway without a deploy, so it has to be a legal value
 * here. The message never repeats what was set: a variable can hold something a log should not.
 */
function dayCeiling(name: string, fallback: string): z.ZodType<number> {
  const MAX = 100_000;
  return z
    .string()
    .trim()
    .default(fallback)
    .transform((value, ctx) => {
      const count = Number(value.length === 0 ? fallback : value);
      if (!Number.isInteger(count) || count < 0 || count > MAX) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a whole number between 0 and ${MAX}, where 0 closes that route for everyone`,
        });
        return z.NEVER;
      }
      return count;
    });
}

/**
 * A whole number of milliseconds, with a default and a floor. The ceiling of a day is there so a
 * value pasted in seconds by mistake, or a stray extra zero, is refused at boot rather than
 * turning a timer off in practice.
 */
function milliseconds(name: string, fallback: number, min: number): z.ZodType<number> {
  const DAY_MS = 86_400_000;
  return z
    .string()
    .trim()
    .default(String(fallback))
    .transform((value, ctx) => {
      const parsed = Number(value.length === 0 ? fallback : value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > DAY_MS) {
        ctx.addIssue({
          code: "custom",
          message: `${name} must be a whole number of milliseconds between ${min} and ${DAY_MS}`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

/**
 * An optional moment in unix seconds, a whole number from 1 to the year 2100. Blank means unset.
 * The message never repeats what was set.
 */
function optionalUnixSeconds(name: string): z.ZodType<number | undefined> {
  return z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.length === 0) {
        return undefined;
      }
      const seconds = /^[0-9]{1,10}$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_ENV_UNIX_SECONDS) {
        ctx.addIssue({ code: "custom", message: `${name} must be a whole number of unix seconds, such as 1790000000` });
        return z.NEVER;
      }
      return seconds;
    });
}

/** 1 January 2100 in unix seconds, the latest moment a setting may name. */
const MAX_ENV_UNIX_SECONDS = 4_102_444_800;

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
 * of sites allowed to spend the operator's Pinata account.
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
    MONAD_RPC_FALLBACK_URL: source.MONAD_RPC_FALLBACK_URL,
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
    PRIVY_EDIT_SIGNER_ID: source.PRIVY_EDIT_SIGNER_ID,
    PRIVY_EDIT_POLICY_ID: source.PRIVY_EDIT_POLICY_ID,
    EDITS_PER_DAY: source.EDITS_PER_DAY,
    GENERATE_PER_DAY: source.GENERATE_PER_DAY,
    GLOBAL_PREPARES_PER_DAY: source.GLOBAL_PREPARES_PER_DAY,
    GLOBAL_GENERATIONS_PER_DAY: source.GLOBAL_GENERATIONS_PER_DAY,
    GLOBAL_EDITS_PER_DAY: source.GLOBAL_EDITS_PER_DAY,
    GLOBAL_UNSEALS_PER_DAY: source.GLOBAL_UNSEALS_PER_DAY,
    GLOBAL_LINKS_PER_DAY: source.GLOBAL_LINKS_PER_DAY,
    PLATFORM_PREPARES_PER_KEY_PER_DAY: source.PLATFORM_PREPARES_PER_KEY_PER_DAY,
    GLOBAL_PLATFORM_PREPARES_PER_DAY: source.GLOBAL_PLATFORM_PREPARES_PER_DAY,
    PRIVATE_SWEEP: source.PRIVATE_SWEEP,
    RUNNER_TOKEN: source.RUNNER_TOKEN,
    SEALED_LINK_TOKEN: source.SEALED_LINK_TOKEN,
    DATA_DIR: source.DATA_DIR,
    RAILWAY_VOLUME_MOUNT_PATH: source.RAILWAY_VOLUME_MOUNT_PATH,
    RECHECK_QUEUE_PATH: source.RECHECK_QUEUE_PATH,
    MOOLAM_REGISTRY_ADDRESS: source.MOOLAM_REGISTRY_ADDRESS,
    CONSENT_ADDRESS: source.CONSENT_ADDRESS,
    CORS_ORIGINS: source.CORS_ORIGINS,
    TRUST_PROXY: source.TRUST_PROXY,
    INDEX_REFRESH_MS: source.INDEX_REFRESH_MS,
    MATCH_WAIT_MS: source.MATCH_WAIT_MS,
    EXPECT_ROUTES: source.EXPECT_ROUTES,
    PRIVY_JWKS_OVERRIDE_PATH: source.PRIVY_JWKS_OVERRIDE_PATH,
    CLAIM_PEPPER: source.CLAIM_PEPPER,
    CLAIM_PEPPER_VERSION: source.CLAIM_PEPPER_VERSION,
    CLAIM_REQUESTS_PER_DAY: source.CLAIM_REQUESTS_PER_DAY,
    NETWORK_ACTIVATION_TIME: source.NETWORK_ACTIVATION_TIME,
    LOOKALIKE_RECEIVER: source.LOOKALIKE_RECEIVER,
    GOOGLE_VISION_API_KEY: source.GOOGLE_VISION_API_KEY,
    VISION_CHECKS_PER_DAY: source.VISION_CHECKS_PER_DAY,
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
