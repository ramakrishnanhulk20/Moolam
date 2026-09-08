import type { PrivyClient } from "@privy-io/node";
import type { Hex } from "viem";
import { loadArtifact } from "../chain/artifacts.js";
import { ownerPublicKey, privy } from "./client.js";

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

/** Creates a policy and returns its id. Privy allows one policy per wallet, so each wallet gets one. */
export async function createPolicy(request: PolicyRequest): Promise<string> {
  const policy = await privy().policies().create(request);
  return policy.id;
}

/** Whether a policy id still exists on the Privy app, so a cached id from a past run is not trusted blindly. */
export async function policyExists(policyId: string): Promise<boolean> {
  try {
    await privy().policies().get(policyId);
    return true;
  } catch {
    return false;
  }
}
