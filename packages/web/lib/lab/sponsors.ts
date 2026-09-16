import type { AbiEvent, Hex } from "viem";
import { readArt } from "@/components/passport/art";
import { DEPLOY_BLOCK, addresses, chain, registryAbi } from "@/lib/chain/client";
import { feeInMon } from "@/lib/chain/fee";
import { bitsApart, phashWord } from "@/lib/chain/fingerprint";
import { readChainHead, readIndexBlock } from "@/lib/status/read";

/**
 * Every figure the sponsor bench draws, read from the chain, the index and the
 * pinned documents.
 *
 * Three of the four panels read the registry's own events rather than the
 * index, because the log carries the transaction hash that the panels are
 * about and the chain answers whether or not a hosted index happens to be up.
 * The fourth panel is about the index, so it asks the index and says plainly
 * when it gets no answer. Nothing here is written into the app: a reader that
 * cannot reach its source hands back the source's own words and the panel shows
 * no number at all rather than one nobody can stand behind.
 */

// The fingerprint arithmetic and the fee sum are shared with the passport page
// and the studio receipt, so they live under lib/chain and the bench reads them
// through here, at the same names it always used.
export { feeInMon } from "@/lib/chain/fee";
export { bitsApart, bitsOf, phashWord } from "@/lib/chain/fingerprint";

/** What a reader gives back: the figures, or why they could not be had. */
export type Reading<T> = { read: T } | { failed: string };

export function isRead<T>(reading: Reading<T>): reading is { read: T } {
  return "read" in reading;
}

async function attempt<T>(work: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { read: await work() };
  } catch (error) {
    return { failed: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

/**
 * The canonical ERC-4337 entry point, v0.7, the same address Privy's bundler
 * sent Moolam's first sponsored transaction through on 2026-09-09. A
 * registration whose transaction went to this contract was paid for by a
 * paymaster rather than out of the creator's own balance.
 */
export const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Hex;

/**
 * How many blocks back the block time is measured over.
 *
 * A Monad block carries its timestamp in whole seconds and the chain seals
 * blocks far faster than that, so two neighbouring blocks almost always read
 * the same second and the difference between them is zero. A window of this
 * size spans about a minute and a half, which a second hand can resolve.
 */
export const BLOCK_TIME_SPAN = 250;

/** How many of the newest registrations are read while looking for a sponsored one. */
export const SPONSORED_SCAN = 40;

/** The picture the Chainlink panel is about, found by the title in its pinned document. */
export const RECHECK_TITLE = "Monsoon Fishing Nets Drying";

const registeredEvent = (registryAbi as AbiEvent[]).find(
  (item) => item.type === "event" && item.name === "PassportRegistered",
) as AbiEvent;

const attestedEvent = (registryAbi as AbiEvent[]).find(
  (item) => item.type === "event" && item.name === "VerificationAttested",
) as AbiEvent;

/** One registration, exactly as the registry's own event carries it. */
export interface RegistrationLog {
  id: Hex;
  creator: Hex;
  agentId: bigint;
  /** The fingerprint the picture was registered with. */
  phash: bigint;
  metadataURI: string;
  block: bigint;
  txHash: Hex;
}

/** One independent re-check, as the registry's own event carries it. */
export interface AttestationLog {
  passportId: Hex;
  receiver: Hex;
  matched: boolean;
  /** How many of the 64 fingerprint bits the two readings disagreed on. */
  distance: number;
  recomputed: Hex;
  block: bigint;
  txHash: Hex;
}

/** One block reduced to the two fields every panel here wants. */
export interface BlockReading {
  number: bigint;
  timestamp: bigint;
}

/**
 * Every source the bench reads, gathered in one place so a test can answer in
 * the network's stead without stubbing a transport.
 */
export interface BenchSource {
  registrations: () => Promise<RegistrationLog[]>;
  attestations: () => Promise<AttestationLog[]>;
  block: (number: bigint) => Promise<BlockReading>;
  transaction: (hash: Hex) => Promise<{ to: Hex | null }>;
  receipt: (hash: Hex) => Promise<{ gasUsed: bigint; effectiveGasPrice: bigint; from: Hex }>;
  passkey: (wallet: Hex) => Promise<boolean>;
  document: (metadataURI: string) => Promise<{ title: string | null; picture: string | null }>;
  indexBlock: () => Promise<number | null>;
  head: () => Promise<number | null>;
}

/**
 * The registry's PassportRegistered events, newest first.
 *
 * One query covers the whole life of the contract: it has emitted fewer than a
 * hundred of these, and the endpoint the app is pointed at allows the range.
 */
async function registrationLogs(): Promise<RegistrationLog[]> {
  const logs = await chain.getLogs({
    address: addresses.registry,
    event: registeredEvent,
    fromBlock: DEPLOY_BLOCK,
    toBlock: "latest",
  });

  return logs
    .map((log) => {
      const args = log.args as {
        passportId: Hex;
        creator: Hex;
        generatorAgentId: bigint;
        phash: bigint;
        metadataURI: string;
      };
      return {
        id: args.passportId,
        creator: args.creator,
        agentId: args.generatorAgentId,
        phash: args.phash,
        metadataURI: args.metadataURI,
        block: log.blockNumber ?? 0n,
        txHash: log.transactionHash as Hex,
      };
    })
    .reverse();
}

/** The registry's VerificationAttested events, newest first. */
async function attestationLogs(): Promise<AttestationLog[]> {
  const logs = await chain.getLogs({
    address: addresses.registry,
    event: attestedEvent,
    fromBlock: DEPLOY_BLOCK,
    toBlock: "latest",
  });

  return logs
    .map((log) => {
      const args = log.args as {
        passportId: Hex;
        receiver: Hex;
        matched: boolean;
        distance: number;
        recomputed: Hex;
      };
      return {
        passportId: args.passportId,
        receiver: args.receiver,
        matched: args.matched,
        distance: args.distance,
        recomputed: args.recomputed,
        block: log.blockNumber ?? 0n,
        txHash: log.transactionHash as Hex,
      };
    })
    .reverse();
}

export const liveSource: BenchSource = {
  registrations: registrationLogs,
  attestations: attestationLogs,
  block: async (number) => {
    const block = await chain.getBlock({ blockNumber: number });
    return { number: block.number ?? number, timestamp: block.timestamp };
  },
  transaction: async (hash) => ({ to: (await chain.getTransaction({ hash })).to }),
  receipt: async (hash) => {
    const receipt = await chain.getTransactionReceipt({ hash });
    return { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, from: receipt.from };
  },
  passkey: async (wallet) => {
    const [qx] = (await chain.readContract({
      address: addresses.registry,
      abi: registryAbi,
      functionName: "getPasskey",
      args: [wallet],
    })) as readonly [Hex, Hex];
    return BigInt(qx) !== 0n;
  },
  document: async (metadataURI) => {
    const art = await readArt(metadataURI);
    return { title: art.title ?? null, picture: art.imageUrl ?? art.thumbnailUrl ?? null };
  },
  indexBlock: async () => await readIndexBlock(),
  head: async () => await readChainHead(),
};

/**
 * Milliseconds per block across a window, rounded.
 *
 * Both ends are block timestamps in whole seconds, so the answer is an average
 * across the window and is labelled as one everywhere it is shown.
 */
export function blockMsAcross(span: BlockReading, block: BlockReading): number {
  const blocks = block.number - span.number;
  if (blocks <= 0n) {
    throw new Error("the window has to end after it starts");
  }
  return Math.round((Number(block.timestamp - span.timestamp) * 1000) / Number(blocks));
}

/** True when a transaction was sent to the ERC-4337 entry point rather than straight to the registry. */
export function throughEntryPoint(to: Hex | null, entryPoint: Hex = ENTRY_POINT): boolean {
  return to !== null && to.toLowerCase() === entryPoint.toLowerCase();
}

export interface MonadReceipt {
  passportId: Hex;
  /** The block the registration landed in. */
  block: BlockReading;
  /** The block before it, which shares its second and is what the note under the panel is about. */
  previous: BlockReading;
  /** The far end of the window the block time is measured across. */
  span: BlockReading;
  /** Milliseconds per block across that window, rounded. */
  blockMs: number;
  /** True when the block and the one before it carry the same second. */
  sameSecond: boolean;
  txHash: Hex;
  gasUsed: bigint | null;
  gasPrice: bigint | null;
  /** Gas billed times the price paid, in MON, or null when the receipt could not be read. */
  feeMon: string | null;
}

/** The newest registration, its block, the block before it, and what the send was billed. */
export async function readMonadReceipt(source: BenchSource = liveSource): Promise<Reading<MonadReceipt>> {
  return await attempt(async () => {
    const newest = (await source.registrations())[0];
    if (newest === undefined) {
      throw new Error("the registry has emitted no registration yet");
    }

    const [block, previous, span, receipt] = await Promise.all([
      source.block(newest.block),
      source.block(newest.block - 1n),
      source.block(newest.block - BigInt(BLOCK_TIME_SPAN)),
      source.receipt(newest.txHash).catch(() => null),
    ]);

    return {
      passportId: newest.id,
      block,
      previous,
      span,
      blockMs: blockMsAcross(span, block),
      sameSecond: block.timestamp === previous.timestamp,
      txHash: newest.txHash,
      gasUsed: receipt?.gasUsed ?? null,
      gasPrice: receipt?.effectiveGasPrice ?? null,
      feeMon: receipt === null ? null : feeInMon(receipt.gasUsed, receipt.effectiveGasPrice),
    };
  });
}

export interface SponsoredRegistration {
  passportId: Hex;
  creator: Hex;
  txHash: Hex;
  block: bigint;
  /** The bundler that sent the transaction. It is not the creator's wallet. */
  sender: Hex;
  gasUsed: bigint;
  gasPrice: bigint;
  /** What this send would have cost the creator out of their own balance, in MON. */
  feeMon: string;
  /** How many of the newest registrations were read before this one turned up. */
  scanned: number;
  /** True when this creator has a passkey bound on chain, which is what signs in place of a seed phrase. */
  passkey: boolean;
}

/**
 * The newest registration a paymaster paid for.
 *
 * The event says which transaction carried each passport but not who paid for
 * it, so the transactions are read newest first until one turns out to have
 * gone through the entry point. Nothing is assumed about how far back that is:
 * a scan that reaches its cap without finding one says so.
 */
export async function readSponsoredRegistration(
  source: BenchSource = liveSource,
  limit = SPONSORED_SCAN,
): Promise<Reading<SponsoredRegistration>> {
  return await attempt(async () => {
    const rows = (await source.registrations()).slice(0, limit);
    if (rows.length === 0) {
      throw new Error("the registry has emitted no registration yet");
    }

    const sent = await Promise.all(rows.map(async (row) => await source.transaction(row.txHash)));
    const at = sent.findIndex((transaction) => throughEntryPoint(transaction.to));
    if (at === -1) {
      throw new Error(
        `none of the newest ${rows.length} registrations went through the entry point, so there is no sponsored one to show`,
      );
    }

    const row = rows[at];
    const [receipt, passkey] = await Promise.all([
      source.receipt(row.txHash),
      source.passkey(row.creator).catch(() => false),
    ]);

    return {
      passportId: row.id,
      creator: row.creator,
      txHash: row.txHash,
      block: row.block,
      sender: receipt.from,
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
      feeMon: feeInMon(receipt.gasUsed, receipt.effectiveGasPrice),
      scanned: at + 1,
      passkey,
    };
  });
}

export interface ChainlinkRecheck {
  passportId: Hex;
  title: string;
  picture: string | null;
  /** The fingerprint the registry stored when the picture was registered. */
  original: bigint;
  /** The fingerprint the independent network computed from the picture it fetched. */
  recomputed: bigint;
  matched: boolean;
  /** How far apart the two readings were, as the receiver wrote it. */
  distance: number;
  /** The same distance counted off the two fingerprints on this page, so the claim can be checked. */
  counted: number;
  /** The second the report landed in, from its own block. */
  at: bigint;
  receiver: Hex;
  reportTx: Hex;
  reportBlock: bigint;
  /** True when the re-check was written through the receiver the Chainlink workflow reports into. */
  chainlink: boolean;
}

/**
 * The independent re-check of one picture, found by the title in its pinned
 * document rather than by an id written into this file, so the panel follows
 * the registry instead of a note somebody made once.
 */
export async function readChainlinkRecheck(
  source: BenchSource = liveSource,
  title = RECHECK_TITLE,
): Promise<Reading<ChainlinkRecheck>> {
  return await attempt(async () => {
    const [attestations, registrations] = await Promise.all([source.attestations(), source.registrations()]);
    if (attestations.length === 0) {
      throw new Error("the registry holds no re-check at all");
    }

    const rechecked = attestations
      .map((attestation) => ({
        attestation,
        registration: registrations.find((row) => row.id.toLowerCase() === attestation.passportId.toLowerCase()),
      }))
      .filter((pair): pair is { attestation: AttestationLog; registration: RegistrationLog } =>
        pair.registration !== undefined,
      );

    const documents = await Promise.all(
      rechecked.map(async (pair) => await source.document(pair.registration.metadataURI).catch(() => null)),
    );
    const at = documents.findIndex((document) => document?.title === title);
    if (at === -1) {
      throw new Error(`none of the ${rechecked.length} re-checked pictures is titled ${title}`);
    }

    const { attestation, registration } = rechecked[at];
    const block = await source.block(attestation.block);
    const recomputed = phashWord(attestation.recomputed);

    return {
      passportId: registration.id,
      title,
      picture: documents[at]?.picture ?? null,
      original: registration.phash,
      recomputed,
      matched: attestation.matched,
      distance: attestation.distance,
      counted: bitsApart(registration.phash, recomputed),
      at: block.timestamp,
      receiver: attestation.receiver,
      reportTx: attestation.txHash,
      reportBlock: attestation.block,
      chainlink: attestation.receiver.toLowerCase() === addresses.receiver.toLowerCase(),
    };
  });
}

export interface EnvioStanding {
  /** The newest block the index says it has finished processing. */
  indexBlock: number;
  /** The chain head, read through the same client every page reads with. */
  head: number;
  /** How far the index trails the head, in blocks. Never below zero. */
  behind: number;
  /** The newest registration the chain holds, and the second its block was sealed in. */
  newestBlock: bigint;
  newestAt: bigint;
  /** How many blocks the index has processed since that registration. */
  sinceNewest: number;
  /**
   * True when the index reports no time at which it saw a block, which is the
   * case today: chain_metadata carries the block it has reached and nothing
   * about when it got there.
   */
  noSeenTime: boolean;
}

/**
 * Where the index stands against the chain.
 *
 * The lag can only honestly be given in blocks, because Envio's chain_metadata
 * has no record of when it processed one. The panel says that in as many words
 * rather than turning a block count into a time nobody measured.
 */
export async function readEnvioStanding(source: BenchSource = liveSource): Promise<Reading<EnvioStanding>> {
  return await attempt(async () => {
    const [indexBlock, head, registrations] = await Promise.all([
      source.indexBlock(),
      source.head(),
      source.registrations(),
    ]);

    if (indexBlock === null) {
      throw new Error("the index did not answer with a processed block");
    }
    if (head === null) {
      throw new Error("the chain did not answer with a head block");
    }

    const newest = registrations[0];
    if (newest === undefined) {
      throw new Error("the registry has emitted no registration yet");
    }

    const block = await source.block(newest.block);

    return {
      indexBlock,
      head,
      behind: Math.max(0, head - indexBlock),
      newestBlock: newest.block,
      newestAt: block.timestamp,
      sinceNewest: Math.max(0, indexBlock - Number(newest.block)),
      noSeenTime: true,
    };
  });
}

export interface SponsorBench {
  monad: Reading<MonadReceipt>;
  privy: Reading<SponsoredRegistration>;
  chainlink: Reading<ChainlinkRecheck>;
  envio: Reading<EnvioStanding>;
}

/**
 * All four panels at once, so the slowest read sets the wait rather than the
 * sum of them. One source object is shared, so the log queries behind it are
 * made once and every panel reads the same registry.
 */
export async function sponsorBench(source: BenchSource = held(liveSource)): Promise<SponsorBench> {
  const [monad, privy, chainlink, envio] = await Promise.all([
    readMonadReceipt(source),
    readSponsoredRegistration(source),
    readChainlinkRecheck(source),
    readEnvioStanding(source),
  ]);
  return { monad, privy, chainlink, envio };
}

/**
 * The same source with the two log queries and every block read asked for once
 * per render. Four panels want the same registration list, and without this the
 * page would ask the endpoint for it four times over.
 */
export function held(source: BenchSource): BenchSource {
  const once = <T>(work: () => Promise<T>): (() => Promise<T>) => {
    let running: Promise<T> | null = null;
    return () => (running ??= work());
  };
  const blocks = new Map<bigint, Promise<BlockReading>>();

  return {
    ...source,
    registrations: once(source.registrations),
    attestations: once(source.attestations),
    block: (number) => {
      const running = blocks.get(number) ?? source.block(number);
      blocks.set(number, running);
      return running;
    },
  };
}
