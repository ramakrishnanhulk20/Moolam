import { createPrivateKey, createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError, PrivyClient, type AuthorizationContext } from "@privy-io/node";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

// One .env at the repo root serves every package, and it has to be read before the schema below
// runs, because that check is what decides whether this process can talk to Privy at all.
loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });

const environment = z.object({
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  PRIVY_AUTHORIZATION_KEY: z.string().min(1),
});

/** Old Privy dashboards handed out keys with this prefix. The SDK strips it, the key parser here must too. */
const KEY_PREFIX = /^wallet-(auth|api):/;

let client: PrivyClient | undefined;

function config(): z.infer<typeof environment> {
  const parsed = environment.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(
      `The root .env is missing or empty for: ${missing}. Fill them in from dashboard.privy.io before running the Privy proof.`,
    );
  }
  return parsed.data;
}

/** The Privy client, built once from the app id and secret in the root .env. */
export function privy(): PrivyClient {
  if (!client) {
    const env = config();
    client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET });
  }
  return client;
}

/**
 * The authorization context that proves this server is allowed to ask Privy's enclave to act as
 * the owner of the wallets it created. The private key never leaves this machine: the SDK signs
 * each request locally and sends only the signature.
 */
export function ownerContext(): AuthorizationContext {
  return { authorization_private_keys: [config().PRIVY_AUTHORIZATION_KEY] };
}

/**
 * The public half of PRIVY_AUTHORIZATION_KEY, in the base64 DER form Privy wants when a wallet
 * names its owner. Derived locally so the .env only ever has to carry the private key.
 */
export function ownerPublicKey(): string {
  const raw = config().PRIVY_AUTHORIZATION_KEY.replace(KEY_PREFIX, "");
  const key = createPrivateKey({
    key: Buffer.from(raw, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
}

/** The CAIP-2 chain name Privy's wallet API expects, for example eip155:143 for Monad mainnet. */
export function caip2(chainId: number): `eip155:${number}` {
  return `eip155:${chainId}`;
}

/**
 * Whether Privy's enclave refused this request because the wallet's policy forbade it.
 *
 * A policy refusal comes back as HTTP 400 with the code policy_violation, which is different
 * from a chain revert: the transaction was never signed and never broadcast.
 */
export function isPolicyViolation(error: unknown): boolean {
  return errorCode(error) === "policy_violation";
}

/** The error code Privy returned, or undefined when the failure came from somewhere else. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const body = error.error as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}

/** One readable line for a Privy failure: the status, the code and the message Privy sent. */
export function privyErrorText(error: unknown): string {
  if (error instanceof APIError) {
    const body = error.error as { code?: unknown; message?: unknown; error?: unknown } | undefined;
    const code = typeof body?.code === "string" ? body.code : "no code";
    const message =
      typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : error.message;
    return `HTTP ${error.status ?? "none"} ${code}: ${message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
