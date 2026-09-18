import { z } from "zod";

/**
 * The variables the browser is allowed to see, checked once at import so a
 * missing or malformed value names itself at boot instead of failing inside a
 * fetch later. Every value here is public by definition: nothing secret may be
 * given a NEXT_PUBLIC_ name.
 */
const schema = z.object({
  privyAppId: z.string().min(1).optional(),
  privySignerId: z.string().min(1).optional(),
  privyEditPolicyId: z.string().min(1).optional(),
  monadRpcUrl: z.url(),
  envioGraphqlUrl: z.url().optional(),
  verifierUrl: z.url(),
  ipfsGateway: z.url(),
});

const parsed = schema.safeParse({
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID || undefined,
  privySignerId: process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID || undefined,
  privyEditPolicyId: process.env.NEXT_PUBLIC_PRIVY_EDIT_POLICY_ID || undefined,
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

/**
 * The dedicated Monad endpoint the server reads through, when one is set.
 *
 * The address itself carries the access token, so this is a secret: it never
 * takes a NEXT_PUBLIC name, it is only read where there is no window, and any
 * address viem writes into an error is taken back out by reason() in
 * lib/chain/client.ts. Leaving it unset is a supported setup and means every
 * read goes to the public endpoint, exactly as before.
 *
 * A value that is not an https URL stops the boot instead of falling back to
 * the public endpoint, because a silent fallback would hide a typo behind the
 * rate limiting this variable exists to escape. The check is one URL parse plus
 * the scheme, so it covers anything that is not an absolute https address and
 * it cannot tell a working endpoint from an expired one.
 */
function serverRpcEndpoint(): string | undefined {
  if (typeof window !== "undefined") {
    return undefined;
  }
  const raw = process.env.MONAD_RPC_URL?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (!z.url({ protocol: /^https$/ }).safeParse(raw).success) {
    // The value is deliberately left out of the message: it is the credential.
    throw new Error("MONAD_RPC_URL is set but is not an https URL. See packages/web/.env.example.");
  }
  return raw;
}

export const serverRpcUrl = serverRpcEndpoint();

/** Privy is optional at build time: without an app id the studio says so instead of crashing. */
export const isPrivyConfigured = publicEnv.privyAppId !== undefined;

/** The key quorum the hosted edit route signs under, and the policy that holds it to appendEdit. */
export interface EditSigner {
  signerId: string;
  policyId: string;
}

/**
 * The two public ids the edit panel needs, or null when either is missing.
 *
 * Both are ids rather than keys: the signer id names the app's key quorum and the policy id names
 * the rule Privy enforces on it. A grant made without the policy is refused by the route, so the
 * panel never offers the button until it has both.
 */
export const editSigner: EditSigner | null =
  publicEnv.privySignerId === undefined || publicEnv.privyEditPolicyId === undefined
    ? null
    : { signerId: publicEnv.privySignerId, policyId: publicEnv.privyEditPolicyId };
