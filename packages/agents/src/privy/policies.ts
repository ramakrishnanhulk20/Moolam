import type { PrivyClient } from "@privy-io/node";
import type { Hex } from "viem";
import { loadArtifact } from "../chain/artifacts.js";
import { ownerContext, ownerPublicKey, privy } from "./client.js";

/** The exact shape Privy's policies().create takes, read off the installed SDK. */
type PolicyRequest = Parameters<ReturnType<PrivyClient["policies"]>["create"]>[0];
type PolicyCondition = PolicyRequest["rules"][number]["conditions"][number];
type CalldataCondition = Extract<PolicyCondition, { field_source: "ethereum_calldata" }>;

/** No native token may leave these wallets, so every allowed send is capped at zero value. */
const NO_VALUE = "0x0";

/**
 * The two registry functions a policy needs to be able to name. Privy decodes the calldata with
 * this ABI, so both have to be present: a function it cannot decode would be refused for the
 * wrong reason and the refusal would prove nothing.
 */
function registryCallAbi(): CalldataCondition["abi"] {
  return loadArtifact("MoolamRegistry").abi.filter(
    (entry) =>
      entry.type === "function" && (entry.name === "register" || entry.name === "appendEdit"),
  ) as CalldataCondition["abi"];
}

/**
 * The generator agent's rulebook, enforced inside Privy's secure enclave rather than by our
 * server code.
 *
 * Two things are allowed and nothing else: send a register call to the Moolam registry on Monad
 * mainnet carrying no MON, and sign an EIP-712 message whose domain is that same registry. Privy
 * denies any method or destination no rule covers, so the agent cannot move funds, cannot touch
 * another contract, and cannot sign for another app even if this server is compromised.
 */
export function generatorPolicy(registry: Hex, chainId: number): PolicyRequest {
  return {
    name: `Moolam generator agent ${registry.slice(0, 10)}`,
    version: "1.0",
    chain_type: "ethereum",
    owner: { public_key: ownerPublicKey() },
    rules: [
      {
        name: "Register passports only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: registry },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: String(chainId),
          },
          {
            field_source: "ethereum_transaction",
            field: "value",
            operator: "lte",
            value: NO_VALUE,
          },
          {
            field_source: "ethereum_calldata",
            field: "function_name",
            abi: registryCallAbi(),
            operator: "eq",
            value: "register",
          },
        ],
      },
      {
        name: "Sign Moolam passport digests only",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_typed_data_domain",
            field: "verifyingContract",
            operator: "eq",
            value: registry,
          },
          {
            field_source: "ethereum_typed_data_domain",
            field: "chainId",
            operator: "eq",
            value: String(chainId),
          },
        ],
      },
    ],
  };
}

/**
 * What the creator's session signer may do on the creator's own wallet.
 *
 * The creator stays the owner of the wallet. This policy is attached to our server's signer key,
 * so the standing permission the creator grants is exactly one thing: append an edit to a
 * passport they already hold, with no MON attached. It cannot register, cannot transfer, cannot
 * touch another contract.
 */
export function sessionSignerPolicy(registry: Hex, chainId: number): PolicyRequest {
  return {
    name: `Moolam edit session ${registry.slice(0, 10)}`,
    version: "1.0",
    chain_type: "ethereum",
    owner: { public_key: ownerPublicKey() },
    rules: [
      {
        name: "Append edits only",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          { field_source: "ethereum_transaction", field: "to", operator: "eq", value: registry },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: String(chainId),
          },
          {
            field_source: "ethereum_transaction",
            field: "value",
            operator: "lte",
            value: NO_VALUE,
          },
          {
            field_source: "ethereum_calldata",
            field: "function_name",
            abi: registryCallAbi(),
            operator: "eq",
            value: "appendEdit",
          },
        ],
      },
    ],
  };
}

/** Anything shaped like an EVM address, used to find which contract a live rule actually names. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type Rules = PolicyRequest["rules"];

/**
 * Every contract address the rules name, lowercased and deduplicated.
 *
 * A policy built for one registry must never survive a redeploy. Reading the addresses straight
 * out of the rules is what lets a caller compare a live policy against the current deployment
 * instead of trusting the id it cached.
 */
export function policyAddresses(rules: Rules): string[] {
  const found = new Set<string>();
  for (const rule of rules) {
    for (const condition of rule.conditions) {
      const value = (condition as { value?: unknown }).value;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === "string" && ADDRESS.test(item)) found.add(item.toLowerCase());
      }
    }
  }
  return [...found];
}

/**
 * The parts of a rule set that decide what Privy will allow, as one comparable string.
 *
 * The decoding ABI is left out because Privy does not echo it back the way it was sent, and the
 * addresses are lowercased so a checksum difference does not look like a changed rule.
 */
function ruleSignature(rules: Rules): string {
  return JSON.stringify(
    rules.map((rule) => ({
      method: rule.method,
      action: rule.action,
      conditions: rule.conditions.map((condition) => {
        const item = condition as unknown as Record<string, unknown>;
        const value = item.value;
        return {
          field_source: item.field_source,
          field: item.field,
          operator: item.operator,
          value:
            typeof value === "string" && ADDRESS.test(value) ? value.toLowerCase() : (value ?? null),
        };
      }),
    })),
  );
}

async function createPolicy(request: PolicyRequest): Promise<string> {
  const policy = await privy().policies().create(request);
  return policy.id;
}

/** The live policy, or undefined when the id no longer resolves on this Privy app. */
async function readPolicy(policyId: string): Promise<{ id: string; rules: Rules } | undefined> {
  try {
    const policy = await privy().policies().get(policyId);
    return { id: policy.id, rules: policy.rules as unknown as Rules };
  } catch {
    return undefined;
  }
}

export type PolicySyncAction = "created" | "updated" | "unchanged";

/**
 * Makes the policy Privy actually enforces match the rules this code builds for the registry that
 * is deployed right now, and proves it by reading the policy back.
 *
 * A cached policy id that still resolves is not evidence of anything: after a registry redeploy
 * the id is the same and every rule inside it still names the old contract, so the enclave refuses
 * the register call and the refusal proves nothing. The whole rules array is rewritten rather than
 * patched condition by condition, which is what stops a rule from being missed. The read-back
 * throws unless the live policy names the current registry and nothing else.
 */
export async function syncPolicy(
  cachedId: string | undefined,
  request: PolicyRequest,
  registry: Hex,
): Promise<{ policyId: string; action: PolicySyncAction }> {
  const target = registry.toLowerCase();
  const wanted = policyAddresses(request.rules);
  if (wanted.length !== 1 || wanted[0] !== target) {
    throw new Error(
      `The policy "${request.name}" was built for ${wanted.join(", ") || "no address"}, not for ${registry}.`,
    );
  }

  const live = cachedId ? await readPolicy(cachedId) : undefined;
  let policyId: string;
  let action: PolicySyncAction;

  if (!live) {
    policyId = await createPolicy(request);
    action = "created";
  } else if (ruleSignature(live.rules) === ruleSignature(request.rules)) {
    policyId = live.id;
    action = "unchanged";
  } else {
    await privy().policies().update(live.id, {
      name: request.name,
      rules: request.rules,
      authorization_context: ownerContext(),
    });
    policyId = live.id;
    action = "updated";
  }

  const confirmed = await readPolicy(policyId);
  if (!confirmed) {
    throw new Error(`Privy did not return policy ${policyId} right after it was ${action}.`);
  }
  const names = policyAddresses(confirmed.rules);
  if (names.length !== 1 || names[0] !== target) {
    throw new Error(
      `Privy policy ${policyId} names ${names.join(", ") || "no address"} in its rules, ` +
        `not the deployed registry ${registry}.`,
    );
  }
  if (ruleSignature(confirmed.rules) !== ruleSignature(request.rules)) {
    throw new Error(`Privy policy ${policyId} does not match the rules Moolam asked for.`);
  }

  return { policyId, action };
}

/** The addresses the live policy names, read back from Privy so a report never prints a guess. */
export async function livePolicyAddresses(policyId: string): Promise<string[]> {
  const policy = await readPolicy(policyId);
  if (!policy) throw new Error(`Privy has no policy ${policyId}.`);
  return policyAddresses(policy.rules);
}
