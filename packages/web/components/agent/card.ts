import { z } from "zod";

/**
 * The ERC-8004 registration card, as much of it as this page draws.
 *
 * Every field is optional because the card is whatever the agent's owner put at
 * its tokenURI. Anything not described here is left alone rather than rejected,
 * so a richer card from a later agent still renders.
 */
const cardSchema = z.object({
  type: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  services: z.array(z.unknown()).optional(),
  privy: z
    .object({
      walletId: z.string().optional(),
      policyId: z.string().optional(),
      policyIds: z.array(z.string()).optional(),
    })
    .optional(),
  walletId: z.string().optional(),
  policyId: z.string().optional(),
});

/** What the card records about the enclave the agent's key lives in, when it records anything. */
export interface PrivyFacts {
  walletId?: string;
  policyIds: string[];
}

export interface AgentCard {
  name?: string;
  description?: string;
  type?: string;
  active?: boolean;
  serviceCount?: number;
  /**
   * Null when the card says nothing about Privy. The page then says nothing
   * about Privy either: a claim about where a key lives has to come from the
   * card, not from this app.
   */
  privy: PrivyFacts | null;
}

export function readCard(card: unknown): AgentCard | null {
  const parsed = cardSchema.safeParse(card);
  if (!parsed.success) {
    return null;
  }

  const { type, name, description, active, services, privy, walletId, policyId } = parsed.data;
  const policyIds = [...(privy?.policyIds ?? []), privy?.policyId, policyId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const wallet = privy?.walletId ?? walletId;

  return {
    name,
    description,
    type,
    active,
    serviceCount: services?.length,
    privy: wallet === undefined && policyIds.length === 0 ? null : { walletId: wallet, policyIds },
  };
}
