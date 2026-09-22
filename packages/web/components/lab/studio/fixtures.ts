import type { Hex } from "viem";
import { consentForChoice } from "@/components/consent/draft";
import type { SealedHandback } from "@/lib/sealed/handback";
import {
  GENERATE_STEPS,
  STEPS,
  initialRegisterState,
  type RegisterState,
  type Step,
  type StepState,
} from "@/lib/studio/flow";
import type { ConsentDraft } from "@/lib/consent/call";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

/**
 * The studio's states, written out by hand so every one of them can be looked
 * at on the bench.
 *
 * Nothing in this file is read from Monad or from the verify service. It is a
 * set of poses for two drawings of the same screen, and the bench says so above
 * them. The shapes are the real ones from lib/studio/flow, so a pose the
 * running screen could never hold would not compile.
 */

/** Which way the picture is being made, which is what the real panel calls mode. */
export type Path = "upload" | "generate";

/**
 * The ten places a creator can be, in the order they happen.
 *
 * "pinning" is its own stop on both paths although neither has a row of its own
 * for it: on the upload path the fingerprint and the pin are one step whose
 * label names both, and on the agent path the draw, the pin and the agent's
 * signature land together in one answer. What changes between "preparing" and
 * "pinning" is how long the creator has been watching, which is the thing worth
 * judging.
 */
export type BenchState =
  | "idle"
  | "preparing"
  | "pinning"
  | "signing"
  | "sending"
  | "unconfirmed"
  | "donePublic"
  | "doneSealed"
  | "failed"
  | "statementFailed";

export const BENCH_STATES: readonly BenchState[] = [
  "idle",
  "preparing",
  "pinning",
  "signing",
  "sending",
  "unconfirmed",
  "donePublic",
  "doneSealed",
  "failed",
  "statementFailed",
];

/** What the dial calls each state. Bench chrome, so it is English and lives here. */
export const STATE_WORDS: Record<BenchState, string> = {
  idle: "Idle",
  preparing: "Preparing",
  pinning: "Pinning",
  signing: "Passkey",
  sending: "Sending",
  unconfirmed: "Unconfirmed",
  donePublic: "Done, public",
  doneSealed: "Done, sealed",
  failed: "Failed",
  statementFailed: "Statement failed",
};

/** The run a drawing plays when its own button is pressed, in milliseconds from the press. */
export const RUN: { state: BenchState; after: number }[] = [
  { state: "preparing", after: 0 },
  { state: "pinning", after: 2_600 },
  { state: "signing", after: 5_200 },
  { state: "sending", after: 8_000 },
  { state: "donePublic", after: 10_400 },
];

export const TITLE = "Harbour at first light";
export const PROMPT = "A harbour at first light, fog on the water, one red hull, shot on 35mm";

const PASSPORT_ID = ("0x" + "9f2c4d".repeat(10) + "aa") as Hex;
const TX = ("0x" + "41b7e0".repeat(10) + "c3") as Hex;
const STATEMENT_TX = ("0x" + "7d3a19".repeat(10) + "e8") as Hex;
const DIGEST = ("0x" + "c4e6b2".repeat(10) + "17") as Hex;
const AGENT_SIG = ("0x" + "cd".repeat(65)) as Hex;
const BLOCKHASH = ("0x" + "6b1f0e".repeat(10) + "92") as Hex;
const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const AGENT_WALLET = "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" as Hex;

/**
 * A picture that already ships with the site, standing in for the pinned copy a
 * real run reads back through the gateway. Local on purpose: the bench should
 * not wait on a gateway to draw a receipt.
 */
export const PICTURE = "/hero/frame-social-chain.jpg";

export const REGISTERED_AT = Date.UTC(2026, 8, 22, 9, 41, 18);

/** What each step took, for the lines that print an elapsed time once a row is done. */
export const TOOK: Partial<Record<Step, number>> = {
  prepare: 9_400,
  draw: 46_800,
  pin: 1_900,
  agentSign: 700,
  sign: 3_100,
  send: 1_842,
};

const WAITING: Record<Step, StepState> = {
  prepare: "waiting",
  draw: "waiting",
  pin: "waiting",
  agentSign: "waiting",
  sign: "waiting",
  send: "waiting",
};

function steps(over: Partial<Record<Step, StepState>>): Record<Step, StepState> {
  return { ...WAITING, ...over };
}

const SAID: ConsentDraft = { consent: consentForChoice("closed"), constraintInfo: "" };

const PREPARED: PrepareResponse = {
  passport: {
    exactHash: PASSPORT_ID,
    parentId: ("0x" + "00".repeat(32)) as Hex,
    generatorAgentId: "0",
    phash: "7840506850305415717",
    blockhash256: BLOCKHASH,
    manifestHash: ("0x" + "22".repeat(32)) as Hex,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://bafkreigmeta",
  },
  image: {
    cid: "bafybeigimage",
    uri: "ipfs://bafybeigimage",
    gatewayUrl: PICTURE,
    bytes: 2_140_992,
    width: 1600,
    height: 1200,
  },
  thumbnail: { cid: "bafybeigthumb", uri: "ipfs://bafybeigthumb", gatewayUrl: PICTURE },
  metadata: { cid: "bafkreigmeta", uri: "ipfs://bafkreigmeta" },
  manifest: { embedded: true },
  preparedBy: "did:privy:bench",
};

const SIGNED_FILE = {
  name: "harbour-at-first-light.signed.jpg",
  type: "image/jpeg",
  bytes: "YmVuY2g=",
  sha256: PASSPORT_ID,
};

const PREPARED_SEALED: PrepareResponse = {
  passport: PREPARED.passport,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  preparedBy: "did:privy:bench",
  sealed: true,
  signedFile: SIGNED_FILE,
  image: undefined,
  thumbnail: undefined,
};

const DRAWN: GenerateResponse = {
  passport: { ...PREPARED.passport, creator: CREATOR, generatorAgentId: "10249", kind: 0, deadline: "1790000000" },
  generatorSig: AGENT_SIG,
  image: PREPARED.image,
  thumbnail: PREPARED.thumbnail,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  model: "gpt-image-1",
  agent: { id: "10249", wallet: AGENT_WALLET },
  quota: { used: 1, limit: 3, resetsAt: Math.floor(REGISTERED_AT / 1000) + 41_000 },
  preparedBy: "did:privy:bench",
};

const DRAWN_SEALED: GenerateResponse = {
  passport: DRAWN.passport,
  generatorSig: AGENT_SIG,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  model: DRAWN.model,
  agent: DRAWN.agent,
  quota: DRAWN.quota,
  preparedBy: "did:privy:bench",
  sealed: true,
  signedFile: SIGNED_FILE,
  image: undefined,
  thumbnail: undefined,
};

/**
 * The one copy of a sealed picture, as the browser would hold it. The blob is
 * built the first time a sealed pose is asked for, because a module that makes
 * one on import makes it on the server too, where nobody is holding anything.
 */
let held: SealedHandback | null = null;
function handback(): SealedHandback {
  held ??= {
    name: SIGNED_FILE.name,
    type: SIGNED_FILE.type,
    blob: new Blob(["bench"], { type: SIGNED_FILE.type }),
    sha256: PASSPORT_ID,
    size: 2_140_992,
  };
  return held;
}

const CHAIN = {
  txHash: TX,
  block: 103_059_393n,
  registeredAt: REGISTERED_AT,
  timing: { waitedMs: 1_842, sealedAfterMs: 2_000 },
  charge: { gasUsed: 657_778n, gasPrice: 102_000_000_000n },
};

const STATED: RegisterState["statement"] = {
  state: "stated",
  sent: SAID,
  hash: STATEMENT_TX,
  at: Math.floor(REGISTERED_AT / 1000) + 6,
  waitedMs: 1_306,
  sponsored: true,
  failure: null,
};

/** Which rows a path draws, which is the real screen's own list. */
export function stepsOf(path: Path): readonly Step[] {
  return path === "generate" ? GENERATE_STEPS : STEPS;
}

export const BENCH_PASSPORT_ID = PASSPORT_ID;
export const BENCH_TX = TX;
export const BENCH_STATEMENT_TX = STATEMENT_TX;

/**
 * One pose, whole. Everything a drawing needs sits on the state itself, exactly
 * as the running screen would hold it, so the two drawings read the same fields
 * and cannot quietly disagree about what done means.
 */
export function fixtureState(path: Path, state: BenchState): RegisterState {
  const base: RegisterState = {
    ...initialRegisterState,
    mode: path === "generate" ? "generate" : "upload",
    title: TITLE,
    prompt: path === "generate" ? PROMPT : "",
    consent: SAID,
    quota: path === "generate" ? DRAWN.quota : null,
  };

  const early: Partial<Record<Step, StepState>> =
    path === "generate" ? { draw: "done", pin: "done", agentSign: "done" } : { prepare: "done" };
  const first: Step = path === "generate" ? "draw" : "prepare";
  const prepared = path === "generate" ? DRAWN : PREPARED;
  const preparedSealed = path === "generate" ? DRAWN_SEALED : PREPARED_SEALED;
  const generated = path === "generate" ? DRAWN : null;
  const generatedSealed = path === "generate" ? DRAWN_SEALED : null;

  switch (state) {
    case "idle":
      return base;
    case "preparing":
    case "pinning":
      return { ...base, steps: steps({ [first]: "running" }) };
    case "signing":
      return { ...base, prepared, generated, steps: steps({ ...early, sign: "running" }) };
    case "sending":
      return {
        ...base,
        prepared,
        generated,
        digest: DIGEST,
        confirming: true,
        steps: steps({ ...early, sign: "done", send: "running" }),
      };
    case "unconfirmed":
      return {
        ...base,
        prepared,
        generated,
        digest: DIGEST,
        txHash: TX,
        steps: steps({ ...early, sign: "done", send: "unconfirmed" }),
        failure: { key: "confirmPending", next: "recheck", address: CREATOR },
      };
    case "donePublic":
      return {
        ...base,
        prepared,
        generated,
        digest: DIGEST,
        ...CHAIN,
        statement: STATED,
        steps: steps({ ...early, sign: "done", send: "done" }),
      };
    case "doneSealed":
      return {
        ...base,
        prepared: preparedSealed,
        generated: generatedSealed,
        digest: DIGEST,
        ...CHAIN,
        statement: STATED,
        sealed: { on: true, includePrompt: false, file: handback(), saved: false },
        steps: steps({ ...early, sign: "done", send: "done" }),
      };
    case "failed":
      return {
        ...base,
        steps: steps({ [first]: "failed" }),
        failure: {
          key: "serviceOffline",
          next: path === "generate" ? "generateAgain" : "again",
          reason: "fetch failed",
        },
      };
    case "statementFailed":
      return {
        ...base,
        prepared,
        generated,
        digest: DIGEST,
        ...CHAIN,
        steps: steps({ ...early, sign: "done", send: "done" }),
        statement: {
          state: "failed",
          sent: null,
          hash: null,
          at: null,
          waitedMs: null,
          sponsored: false,
          failure: { key: "declined", next: "again" },
        },
      };
  }
}

/** One row of the strip under the panel. */
export interface BenchPicture {
  id: Hex;
  title: string;
  /** Null for a sealed record, which has no picture anyone else can fetch. */
  image: string | null;
  when: string;
  kind: string;
}

/**
 * Four rows for the strip, newest first. The newest is the picture the run on
 * this bench just made, which is how a creator finds it a second after the
 * press instead of hunting for it.
 */
export const PICTURES_MADE: BenchPicture[] = [
  { id: PASSPORT_ID, title: TITLE, image: PICTURE, when: "Just now", kind: "Uploaded" },
  {
    id: ("0x" + "2b7e15".repeat(10) + "c4") as Hex,
    title: "Nightline, second pass",
    image: "/hero/frame-reencode-q60.jpg",
    when: "21 Sep 2026, 18:04",
    kind: "Agent drawing",
  },
  {
    id: ("0x" + "8ad4f1".repeat(10) + "06") as Hex,
    title: "Kept, not published",
    image: null,
    when: "19 Sep 2026, 11:27",
    kind: "Sealed",
  },
  {
    id: ("0x" + "05c9b3".repeat(10) + "7f") as Hex,
    title: "Quarry road",
    image: "/hero/frame-reencode-q30.jpg",
    when: "14 Sep 2026, 08:12",
    kind: "Uploaded",
  },
];
