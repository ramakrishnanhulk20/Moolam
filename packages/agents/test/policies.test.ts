// Covers the exact rules Moolam asks Privy to enforce inside its enclave: what the generator
// agent's wallet may send and sign, and what the creator's session signer may do.
// Does NOT cover Privy enforcing them. That was proven against the live app in
// proofs/agent-transcript.txt, where a policy violation came back as a refusal with no
// transaction signed. This file is the guard against the rules being loosened by accident.

import { describe, expect, it } from "vitest";
import { MONAD_MAINNET } from "../src/chain/addresses.js";
import { generatorPolicy, policyAddresses, sessionSignerPolicy } from "../src/privy/policies.js";

const REGISTRY = "0x1cE43b76D0A4a1F1D1FEA9F2a8b32BE1c1f9F0aE";
const REDEPLOYED_REGISTRY = "0xa19188801E5DC93CD925884d73e4DaFc2bcb80C0";
const CHAIN_ID = MONAD_MAINNET.chainId;

type Condition = Record<string, unknown>;

function conditionsOf(rules: { method: string; conditions: readonly unknown[] }[], method: string): Condition[] {
  const rule = rules.find((entry) => entry.method === method);
  expect(rule, `no rule for ${method}`).toBeDefined();
  return (rule?.conditions ?? []) as Condition[];
}

describe("generator agent policy", () => {
  it("allows only a register call to the Moolam registry on Monad, carrying no MON", () => {
    const policy = generatorPolicy(REGISTRY, CHAIN_ID);
    const conditions = conditionsOf(policy.rules, "eth_sendTransaction");

    expect(CHAIN_ID).toBe(143);
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules.every((rule) => rule.action === "ALLOW")).toBe(true);
    expect(conditions).toContainEqual({
      field_source: "ethereum_transaction",
      field: "to",
      operator: "eq",
      value: REGISTRY,
    });
    expect(conditions).toContainEqual({
      field_source: "ethereum_transaction",
      field: "chain_id",
      operator: "eq",
      value: "143",
    });
    expect(conditions).toContainEqual({
      field_source: "ethereum_transaction",
      field: "value",
      operator: "lte",
      value: "0x0",
    });

    const calldata = conditions.find((condition) => condition.field_source === "ethereum_calldata");
    expect(calldata?.field).toBe("function_name");
    expect(calldata?.operator).toBe("eq");
    expect(calldata?.value).toBe("register");
  });

  it("lets the wallet sign typed data only for the Moolam registry's own domain", () => {
    const conditions = conditionsOf(generatorPolicy(REGISTRY, CHAIN_ID).rules, "eth_signTypedData_v4");

    expect(conditions).toEqual([
      {
        field_source: "ethereum_typed_data_domain",
        field: "verifyingContract",
        operator: "eq",
        value: REGISTRY,
      },
      {
        field_source: "ethereum_typed_data_domain",
        field: "chainId",
        operator: "eq",
        value: "143",
      },
    ]);
  });

  it("names the two registry functions in the ABI Privy decodes calldata with", () => {
    const conditions = conditionsOf(generatorPolicy(REGISTRY, CHAIN_ID).rules, "eth_sendTransaction");
    const calldata = conditions.find((condition) => condition.field_source === "ethereum_calldata");
    const abi = (calldata?.abi ?? []) as { name?: string }[];

    expect(abi.map((entry) => entry.name).sort()).toEqual(["appendEdit", "register"]);
  });
});

describe("session signer policy", () => {
  it("allows one thing only: appending an edit to the same registry, with no MON attached", () => {
    const policy = sessionSignerPolicy(REGISTRY, CHAIN_ID);

    expect(policy.rules).toHaveLength(1);
    const rule = policy.rules[0];
    expect(rule?.method).toBe("eth_sendTransaction");
    expect(rule?.action).toBe("ALLOW");

    const conditions = (rule?.conditions ?? []) as unknown as Condition[];
    const calldata = conditions.find((condition) => condition.field_source === "ethereum_calldata");
    expect(calldata?.field).toBe("function_name");
    expect(calldata?.value).toBe("appendEdit");
    expect(conditions).toContainEqual({
      field_source: "ethereum_transaction",
      field: "to",
      operator: "eq",
      value: REGISTRY,
    });
    expect(conditions).toContainEqual({
      field_source: "ethereum_transaction",
      field: "value",
      operator: "lte",
      value: "0x0",
    });
  });
});

describe("a policy built after a registry redeploy", () => {
  it("carries the new address in every rule of both policies and mentions the old one nowhere", () => {
    const generator = generatorPolicy(REDEPLOYED_REGISTRY, CHAIN_ID);
    const session = sessionSignerPolicy(REDEPLOYED_REGISTRY, CHAIN_ID);
    const wanted = REDEPLOYED_REGISTRY.toLowerCase();

    for (const policy of [generator, session]) {
      expect(policyAddresses(policy.rules)).toEqual([wanted]);
      for (const rule of policy.rules) {
        const named = policyAddresses([rule]);
        expect(named, `rule "${rule.name}" names no contract`).toEqual([wanted]);
      }
      expect(JSON.stringify(policy).toLowerCase()).not.toContain(REGISTRY.toLowerCase());
    }

    // The signing rule is the one a stale address hides in: a wrong verifyingContract is refused
    // before the transaction is ever built, so the failure looks like a bad signature.
    const signing = generator.rules.find((rule) => rule.method === "eth_signTypedData_v4");
    expect(policyAddresses(signing ? [signing] : [])).toEqual([wanted]);
  });
});
