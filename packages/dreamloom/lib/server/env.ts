import path from "node:path";
import { z } from "zod";

/**
 * Dreamloom's server settings, read from process.env the first time anything asks for them.
 *
 * In production every secret and every URL is required, and a missing or malformed one stops the
 * server with a line that names the variable and never its value. Anywhere else a missing secret
 * only closes the action that needs it, so the screen can be built without keys.
 */

const blankIsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const text = (schema: z.ZodType<string>) => z.preprocess(blankIsUnset, schema.optional());

/** A URL the server calls or links to: https, or http to this machine for local work. */
const serviceUrl = text(
  z.string().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
    } catch {
      return false;
    }
  }),
);

/** Dreamloom's own origin, the one value every POST's Origin header must equal. */
const siteOrigin = text(z.string().refine((value) => canonicalOrigin(value) !== null));

/** The origin a local dev server answers on, used when DREAMLOOM_ORIGIN is unset outside production. */
const LOCAL_ORIGIN = "http://localhost:3300";

const privateKey = text(z.string().regex(/^0x[0-9a-fA-F]{64}$/));

/**
 * A daily cap. The ceiling is far above anything the demo needs, so a typo with extra zeros is
 * refused rather than taken as a budget.
 */
const cap = (fallback: number) => z.preprocess(blankIsUnset, z.coerce.number().int().min(0).max(100_000).default(fallback));

const schema = z.object({
  NODE_ENV: z.string().optional(),
  MOOLAM_VERIFY_URL: serviceUrl,
  MOOLAM_SITE_URL: serviceUrl,
  MOOLAM_INDEX_URL: serviceUrl,
  MONAD_RPC_URL: serviceUrl,
  DREAMLOOM_ORIGIN: siteOrigin,
  DREAMLOOM_WALLET_KEY: privateKey,
  DREAMLOOM_PASSKEY_KEY: privateKey,
  DREAMLOOM_PASSKEY_RP_ID: text(z.string().min(1).max(253)),
  DREAMLOOM_PLATFORM_KEY: text(z.string().regex(/^[0-9a-fA-F]{64}$/)),
  OPENAI_API_KEY: text(z.string().min(1).max(512)),
  DATA_DIR: text(z.string().min(1).max(1024)),
  WEAVES_PER_ADDRESS_PER_DAY: cap(5),
  WEAVES_PER_DAY: cap(60),
  REGISTRATIONS_PER_DAY: cap(10),
  MOVES_PER_DAY: cap(10),
  COSIGNS_PER_DAY: cap(30),
});

/** Everything a production server cannot run without. */
const REQUIRED_IN_PRODUCTION = [
  "MOOLAM_VERIFY_URL",
  "MOOLAM_SITE_URL",
  "MOOLAM_INDEX_URL",
  "MONAD_RPC_URL",
  "DREAMLOOM_ORIGIN",
  "DREAMLOOM_WALLET_KEY",
  "DREAMLOOM_PASSKEY_KEY",
  "DREAMLOOM_PASSKEY_RP_ID",
  "DREAMLOOM_PLATFORM_KEY",
  "OPENAI_API_KEY",
] as const;

type Parsed = z.infer<typeof schema>;

export interface ServerEnv extends Omit<Parsed, "DATA_DIR" | "NODE_ENV" | "DREAMLOOM_ORIGIN"> {
  production: boolean;
  dataDir: string;
  /** Already in canonicalOrigin's form, so a comparison with a header parsed the same way is exact. */
  origin: string;
}

/** Thrown when the settings cannot run the server. Its message holds variable names only. */
export class EnvError extends Error {
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(`Dreamloom cannot start: set ${names.join(", ")} (missing or malformed)`);
    this.name = "EnvError";
    this.names = names;
  }
}

/**
 * The one parser both sides of the Origin check go through: the WHATWG URL parser's origin, and
 * only for an http or https value that is an origin and nothing more (no user, path beyond "/",
 * query or fragment). Anything else, including the literal "null" a sandboxed page sends, is null.
 */
export function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href === `${url.origin}/` ? url.origin : null;
}

export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Parses a set of variables. Exported apart from env() so the rules can be tested without a cache. */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    // zod's issue text can quote the value it refused, so only the path, the variable's name, is kept.
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "unknown")))];
    throw new EnvError(names);
  }
  const parsed = result.data;
  const production = parsed.NODE_ENV === "production";
  if (production) {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => parsed[name] === undefined);
    if (missing.length > 0) {
      throw new EnvError(missing);
    }
  }
  const { DATA_DIR, NODE_ENV: _nodeEnv, DREAMLOOM_ORIGIN, ...rest } = parsed;
  return {
    ...rest,
    production,
    dataDir: path.resolve(DATA_DIR ?? ".dreamloom-data"),
    origin: canonicalOrigin(DREAMLOOM_ORIGIN ?? LOCAL_ORIGIN) as string,
  };
}

let cached: ServerEnv | undefined;

/**
 * The server's settings, parsed once per process.
 *
 * Throws EnvError naming what is missing or malformed. In production the route guard turns that
 * into a stop, because a server that runs with half its settings spends or refuses at random.
 */
export function env(): ServerEnv {
  cached ??= parseEnv(process.env);
  return cached;
}
