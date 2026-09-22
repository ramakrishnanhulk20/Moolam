import { encodeAbiParameters, type Abi } from "viem";
import { CHAIN_ID, chain } from "@/lib/chain/client";
import { refusalOf, type Refusal } from "./decode";
import type { Attack, Encoders } from "./attacks";

/**
 * One row's answer, with the block it was asked at.
 *
 * The block is part of the answer: a simulation is only true of the state at
 * one height, and a reader who wants to repeat it with cast needs the number.
 */
export type Asked =
  | { kind: "refused"; name: string; args: readonly unknown[]; decoded: boolean; block: bigint }
  | { kind: "empty"; block: bigint }
  | { kind: "passed"; block: bigint }
  | { kind: "unknown" };

/**
 * The four ABIs, fetched the first time a reader presses a button.
 *
 * They are 60 KB of JSON between them and nobody reading the rest of the
 * documentation needs a byte of it, so they are not in the page that loads.
 */
let abis: Record<string, Abi> | null = null;

async function abiFor(name: string): Promise<Abi> {
  if (abis === null) {
    const [consent, registry, receiver] = await Promise.all([
      import("../../../../contracts/abi/MoolamConsent.json"),
      import("../../../../contracts/abi/MoolamRegistry.json"),
      import("../../../../contracts/abi/MoolamReceiver.json"),
    ]);
    abis = {
      consent: consent.default as Abi,
      registry: registry.default as Abi,
      receiver: receiver.default as Abi,
    };
  }
  return abis[name];
}

const REPORT_FIELDS = [
  { type: "uint256" },
  { type: "uint64" },
  { type: "bytes32" },
  { type: "bool" },
  { type: "uint16" },
  { type: "bytes32" },
] as const;

const encoders: Encoders = {
  report: (passportId, at) =>
    encodeAbiParameters(REPORT_FIELDS, [BigInt(CHAIN_ID), at, passportId, true, 0, passportId]),
};

/**
 * Sends one attack as an eth_call and reads back what the contract would have
 * done.
 *
 * eth_call runs the same bytecode a transaction would run and throws the state
 * away at the end, so the refusal is the contract's own and nothing on Monad
 * moves. `account` is how the node is told which address to run it as: no key
 * is involved, which is why an attack from the burn address can be asked at
 * all. The call is pinned to the block that was just read, so the answer and
 * the block number on the screen are the same moment.
 *
 * Anything that is not the chain's answer comes back as "unknown" and the row
 * says it could not ask. A failed read never becomes a refusal on the screen.
 */
export async function ask(attack: Attack): Promise<Asked> {
  let block: { number: bigint | null; timestamp: bigint };
  try {
    block = await chain.getBlock();
  } catch {
    return { kind: "unknown" };
  }
  if (block.number === null) {
    return { kind: "unknown" };
  }
  const at = block.number;

  const abi = await abiFor(attack.abi);

  try {
    if (attack.fn === "") {
      // No function and no data: a plain transfer, which is the whole attack.
      await chain.call({ account: attack.from, to: attack.address, value: attack.value, blockNumber: at });
      return { kind: "passed", block: at };
    }
    await chain.simulateContract({
      account: attack.from,
      address: attack.address,
      abi,
      functionName: attack.fn,
      args: attack.args(block.timestamp, encoders) as unknown[],
      value: attack.value,
      blockNumber: at,
    });
    return { kind: "passed", block: at };
  } catch (error) {
    return answered(refusalOf(error, abi), at);
  }
}

function answered(refusal: Refusal, block: bigint): Asked {
  if (refusal.kind === "refused") {
    return { kind: "refused", name: refusal.name, args: refusal.args, decoded: refusal.decoded, block };
  }
  if (refusal.kind === "empty") {
    return { kind: "empty", block };
  }
  return { kind: "unknown" };
}
