import { z } from "zod";

/**
 * The variables the browser is allowed to see, checked once at import so a
 * missing or malformed value names itself at boot instead of failing inside a
 * fetch later. Every value here is public by definition: nothing secret may be
 * given a NEXT_PUBLIC_ name.
 */
const schema = z.object({
  privyAppId: z.string().min(1).optional(),
  monadRpcUrl: z.url(),
  envioGraphqlUrl: z.url().optional(),
  verifierUrl: z.url(),
  ipfsGateway: z.url(),
});

const parsed = schema.safeParse({
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined,
  monadRpcUrl: process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc1.monad.xyz",
  envioGraphqlUrl: process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || undefined,
  verifierUrl: process.env.NEXT_PUBLIC_VERIFIER_URL || "http://localhost:4010",
  ipfsGateway: process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs/",
});

if (!parsed.success) {
  const detail = parsed.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`).join("; ");
  throw new Error(`The web app's public environment is not usable: ${detail}. See packages/web/.env.example.`);
}

export const publicEnv = parsed.data;

/** Privy is optional at build time: without an app id the studio says so instead of crashing. */
export const isPrivyConfigured = publicEnv.privyAppId !== undefined;
