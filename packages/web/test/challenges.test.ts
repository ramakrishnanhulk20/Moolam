import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { getAddress, hashTypedData, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import en from "@/messages/en.json";
import { addresses } from "@/lib/chain/client";
import type { Dispute } from "@/lib/chain/registry";
import {
  CHALLENGE_ANSWER_TYPES,
  answerHashOf,
  answerTextProblem,
  answerTypedData,
  holderWords,
  refusalOf,
  walletTypedData,
  type AnswerDocument,
} from "@/lib/disputes/answer";
import { decisionView, type DecisionRead } from "@/lib/disputes/decisions";
import { BURN_ADDRESS, bondFate, initialFlagState } from "@/lib/disputes/flag";
import { pinnedLink } from "@/lib/disputes/evidence";
import { answerStanding } from "@/lib/disputes/standing";
import type { FlagPassport } from "@/lib/disputes/useFlagPassport";
import type { HolderAnswer as HolderAnswerHook } from "@/lib/disputes/useHolderAnswer";

// Covers the challenge screens of WO-284c from fixtures: L26 (the typed data the holder's wallet
// signs is the verify service's, field for field), L27 (an answer is drawn only when it matches
// this dispute and the holder's signature, as text with its line breaks), L28 (a decision counts
// only when it says what the registry says, and its reasons address is a link only as ipfs://<cid>),
// L29 (the challenger's evidence address is a link only as ipfs://<cid>), the flag panel's rules
// and its bond line, and who is offered the answer form.
// Does NOT cover a real Privy wallet prompt, the live verify service, the live index or chain, or
// the resolver console's publish step (step 6, waiting on WO-275c).

const flagStub = vi.hoisted(() => ({ current: null as unknown as FlagPassport }));
const answerStub = vi.hoisted(() => ({ current: null as unknown as HolderAnswerHook }));
vi.mock("@/lib/disputes/useFlagPassport", () => ({ useFlagPassport: () => flagStub.current }));
vi.mock("@/lib/disputes/useHolderAnswer", () => ({ useHolderAnswer: () => answerStub.current }));
vi.mock("@/lib/passport/refresh", () => ({ refreshPassport: async () => undefined }));
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; className?: string; children?: unknown }) =>
    createElement("a", { href: props.href, className: props.className }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const { Challenge } = await import("@/components/passport/Challenge");
const { ChallengeRecord } = await import("@/components/challenge/ChallengeRecord");
const { AnswerShown } = await import("@/components/challenge/AnswerShown");
const { AnswerForm } = await import("@/components/challenge/AnswerForm");
const { DecisionBlock } = await import("@/components/challenge/DecisionBlock");
const { HolderAnswer } = await import("@/components/challenge/HolderAnswer");
const { HolderAnswerPanel } = await import("@/components/challenge/HolderAnswerPanel");
const { ChallengedList } = await import("@/components/mine/ChallengedPictures");
const { WalletMounted } = await import("@/components/providers/WalletProvider");

const PASSPORT = `0x${"5c".repeat(32)}` as Hex;
const OPENED_AT = 1_790_000_000;
const holder = privateKeyToAccount(`0x${"51".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"52".repeat(32)}`);
const CHALLENGER = getAddress("0x85a88Ca81Ff5F681D96AB86fA60ccB8452a139a6");
const CID = `bafkreid${"q".repeat(52)}`;
const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
  locale: string;
  messages: unknown;
  timeZone: string;
  formats?: unknown;
}>;

function render(node: ReactElement, mounted = false): string {
  const tree = mounted ? createElement(WalletMounted.Provider, { value: true }, node) : node;
  return renderToStaticMarkup(
    createElement(
      Provider,
      {
        locale: "en",
        messages: en,
        timeZone: "UTC",
        formats: { dateTime: { moment: { dateStyle: "medium", timeStyle: "short" } } },
      },
      tree,
    ),
  );
}

function dispute(over: Partial<Dispute> = {}): Dispute {
  return {
    challenger: CHALLENGER,
    bond: parseEther("1"),
    evidenceHash: `0x${"ab".repeat(32)}`,
    status: 1,
    openedAt: BigInt(OPENED_AT),
    ...over,
  };
}

/** A pinned answer document exactly as the service builds it, signed by this key over this text. */
async function signedDocument(text: string, signer = holder, over: Partial<AnswerDocument> = {}): Promise<AnswerDocument> {
  const deadline = OPENED_AT + 600;
  const signature = await signer.signTypedData(
    answerTypedData({
      passportId: PASSPORT,
      openedAt: BigInt(OPENED_AT),
      challenger: CHALLENGER,
      answerHash: answerHashOf(text),
      deadline: BigInt(deadline),
    }),
  );
  return {
    kind: "moolam-challenge-answer",
    version: 1,
    chainId: 143,
    registry: getAddress(addresses.registry),
    passportId: PASSPORT,
    openedAt: OPENED_AT,
    challenger: CHALLENGER,
    holder: holder.address,
    text,
    answerHash: answerHashOf(text),
    deadline,
    signature,
    ...over,
  };
}

const VERIFIER = (path: string) => readFileSync(fileURLToPath(new URL(`../../verifier/src/${path}`, import.meta.url)), "utf8");

describe("L26: the holder signs the very typed data the verify service recovers", () => {
  it("names the same five fields in the same order as the service's ChallengeAnswer", () => {
    const source = VERIFIER("challenges/answer.ts");
    const block = /ChallengeAnswer: \[([\s\S]*?)\],/.exec(source)?.[1] ?? "";
    const fields = [...block.matchAll(/name: "(\w+)", type: "(\w+)"/g)].map((match) => ({ name: match[1], type: match[2] }));
    expect(fields).toEqual(CHALLENGE_ANSWER_TYPES.ChallengeAnswer.map((field) => ({ ...field })));
    expect(fields).toHaveLength(5);
  });

  it("signs in Moolam's registry domain on Monad, as the service's domain() builds it", () => {
    expect(VERIFIER("generate/eip712.ts")).toContain('return { name: "Moolam", version: "1", chainId, verifyingContract: registry };');
    expect(VERIFIER("reputation/registry.ts")).toContain("export const MONAD_CHAIN_ID = 143;");
    const typed = answerTypedData({
      passportId: PASSPORT,
      openedAt: 1n,
      challenger: CHALLENGER,
      answerHash: answerHashOf("x"),
      deadline: 2n,
    });
    expect(typed.domain).toEqual({ name: "Moolam", version: "1", chainId: 143, verifyingContract: addresses.registry });
  });

  it("hands the wallet a JSON-safe copy that hashes to the same digest, and its signature recovers to the holder", async () => {
    const message = {
      passportId: PASSPORT,
      openedAt: BigInt(OPENED_AT),
      challenger: CHALLENGER,
      answerHash: answerHashOf("My answer."),
      deadline: BigInt(OPENED_AT + 600),
    };
    const wallet = walletTypedData(message);
    expect(JSON.parse(JSON.stringify(wallet))).toEqual(wallet);
    expect(hashTypedData(wallet as never)).toBe(hashTypedData(answerTypedData(message)));
  });

  it("hashes the text's UTF-8 bytes with sha256, line breaks included", () => {
    expect(answerHashOf("abc")).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(answerHashOf("one\ntwo")).not.toBe(answerHashOf("one two"));
  });

  it("checks the text by the service's rule before the wallet is asked", () => {
    expect(answerTextProblem("First paragraph.\n\nSecond paragraph.")).toBeNull();
    expect(answerTextProblem("Windows\r\nbreak")).toBeNull();
    expect(answerTextProblem("   \n  ")).toBe("empty");
    expect(answerTextProblem("lone\rreturn")).toBe("notPrintable");
    expect(answerTextProblem("tab\there")).toBe("notPrintable");
    expect(answerTextProblem("‮reversed")).toBe("notPrintable");
    expect(answerTextProblem("é".repeat(2_000))).toBeNull();
    expect(answerTextProblem(`${"é".repeat(2_000)}x`)).toBe("tooLong");
  });

  it("maps every refusal word the service sends to its own line", () => {
    const words: [number, string, string][] = [
      [409, "no-open-dispute", "noOpenDispute"],
      [409, "answer-window-closed", "windowClosed"],
      [403, "answer-expired", "expired"],
      [409, "no-holder", "noHolder"],
      [403, "not-the-holder", "notHolder"],
      [409, "signature-used", "signatureUsed"],
      [409, "already-answered", "alreadyAnswered"],
      [409, "answering", "answering"],
      [503, "answers-unavailable", "unavailable"],
      [503, "chain-unreachable", "chainUnreachable"],
      [502, "pin-failed", "pinFailed"],
      [429, "route-limit", "busy"],
      [429, undefined as never, "busy"],
      [400, "the answer is empty", "empty"],
      [400, "the answer is over 4000 bytes", "tooLong"],
      [400, "the answer must be printable text, with line breaks as its only control characters and no direction characters", "notPrintable"],
      [404, "not-found", "unavailable"],
      [500, "boom", "unknown"],
    ];
    for (const [status, word, key] of words) {
      expect(refusalOf(status, word), word).toBe(key);
      expect(en.challenge.answer.refusals).toHaveProperty(key);
    }
  });
});

describe("L27: an answer is drawn only beside the dispute it answers, as the holder's own words", () => {
  const disputeShape = { challenger: CHALLENGER, openedAt: OPENED_AT };

  it("accepts the holder's signed answer and keeps its line breaks", async () => {
    const text = "I took this at dawn.\nThe camera file is on my drive.";
    const words = await holderWords({ answerURI: `ipfs://${CID}`, answer: await signedDocument(text) }, PASSPORT, disputeShape);
    expect(words).toEqual({ text, holder: holder.address, answerURI: `ipfs://${CID}` });
  });

  it("refuses an answer for another dispute, passport, registry or chain, or whose hash or signer is wrong", async () => {
    const text = "This is mine.";
    const cases: Partial<AnswerDocument>[] = [
      { openedAt: OPENED_AT + 1 },
      { challenger: stranger.address },
      { passportId: `0x${"6d".repeat(32)}` },
      { registry: stranger.address },
      { chainId: 1 },
      { answerHash: answerHashOf("Other words.") },
      { text: "Other words." },
      { holder: stranger.address },
    ];
    for (const over of cases) {
      const document = await signedDocument(text, holder, over);
      expect(await holderWords({ answerURI: `ipfs://${CID}`, answer: document }, PASSPORT, disputeShape), JSON.stringify(over)).toBeNull();
    }
    const forged = await signedDocument(text, stranger);
    expect(await holderWords({ answerURI: `ipfs://${CID}`, answer: forged }, PASSPORT, disputeShape)).toBeNull();
  });

  it("says until when an open dispute waits, that the 14 days passed, or that the read failed, and nothing for a settled one", async () => {
    const until = OPENED_AT + 14 * 86_400;
    const base = { passportId: PASSPORT, dispute: dispute() };
    expect(await answerStanding({ ...base, read: { kind: "none" }, now: OPENED_AT + 60 })).toEqual({ kind: "waiting", until });
    expect(await answerStanding({ ...base, read: { kind: "none" }, now: until + 1 })).toEqual({ kind: "missed" });
    expect(await answerStanding({ ...base, read: { kind: "failed" }, now: OPENED_AT })).toEqual({ kind: "unread" });
    expect(await answerStanding({ ...base, dispute: dispute({ status: 3 }), read: { kind: "none" }, now: OPENED_AT })).toEqual({ kind: "none" });
  });

  it("draws the words as text with their line breaks, never as markup or a link", () => {
    const text = 'Line one <a href="https://evil.example">click</a>\nhttps://evil.example/second';
    const markup = render(
      createElement(AnswerShown, { standing: { kind: "answered", words: { text, holder: holder.address, answerURI: `ipfs://${CID}` } } }),
    );
    expect(markup).toContain("whitespace-pre-line");
    expect(markup).toContain("Line one &lt;a href=");
    expect(markup).toContain("\nhttps://evil.example/second");
    expect(markup).not.toContain('href="https://evil.example');
    expect(markup).toContain("The holder&#x27;s answer");
    expect(markup).toContain(`Signed by ${holder.address.slice(0, 8)}`);
  });

  it("says the waiting, missed and unread lines in words", () => {
    expect(render(createElement(AnswerShown, { standing: { kind: "waiting", until: OPENED_AT + 14 * 86_400 } }))).toContain(
      "The holder has not answered yet. They have until Oct 5, 2026.",
    );
    expect(render(createElement(AnswerShown, { standing: { kind: "missed" } }))).toContain("did not answer within the 14 days");
    expect(render(createElement(AnswerShown, { standing: { kind: "unread" } }))).toContain("could not be read just now");
  });
});

describe("who is offered the answer form", () => {
  function hook(over: Partial<HolderAnswerHook> = {}): HolderAnswerHook {
    return {
      ready: true,
      isHolder: true,
      text: "",
      phase: "idle",
      refusal: null,
      answerURI: null,
      sent: null,
      setText: NOOP,
      submit: ASYNC_NOOP,
      ...over,
    };
  }
  const props = {
    passportId: PASSPORT,
    dispute: { challenger: CHALLENGER, openedAt: OPENED_AT },
    until: OPENED_AT + 14 * 86_400,
    fallback: createElement("p", null, "FALLBACK"),
  };

  it("shows the holding wallet the form", () => {
    answerStub.current = hook();
    const markup = render(createElement(HolderAnswerPanel, props));
    expect(markup).toContain("Answer this challenge");
    expect(markup).toContain("Sign and send my answer");
    expect(markup).not.toContain("FALLBACK");
  });

  it("shows everybody else, and the holder before the wallet answers, only the waiting line", () => {
    answerStub.current = hook({ isHolder: false });
    expect(render(createElement(HolderAnswerPanel, props))).toBe(render(createElement("p", null, "FALLBACK")));
    answerStub.current = hook({ ready: false });
    expect(render(createElement(HolderAnswerPanel, props))).toBe(render(createElement("p", null, "FALLBACK")));
    expect(render(createElement(HolderAnswer, props), true)).toContain("FALLBACK");
    expect(render(createElement(HolderAnswer, props))).toContain("FALLBACK");
  });

  it("is never placed beside a dispute that is settled, missed or answered", () => {
    for (const answer of [{ kind: "missed" }, { kind: "none" }, { kind: "unread" }] as const) {
      const markup = render(createElement(ChallengeRecord, { passportId: PASSPORT, dispute: dispute(), evidence: null, answer }));
      expect(markup).not.toContain("Answer this challenge");
    }
  });

  it("prints every state and every refusal in words", () => {
    const form = (over: Partial<HolderAnswerHook>) =>
      render(createElement(AnswerForm, { answer: hook(over), until: OPENED_AT + 14 * 86_400 }));
    expect(form({ phase: "signing" })).toContain("Waiting for your wallet to sign");
    expect(form({ phase: "sending" })).toContain("Sending your answer");
    const done = form({ phase: "done", sent: "Paragraph one.\nParagraph two." });
    expect(done).toContain("Your answer is pinned and shown on this passport.");
    expect(done).toContain("Paragraph one.\nParagraph two.");
    for (const key of Object.keys(en.challenge.answer.refusals)) {
      const markup = form({ refusal: key as never });
      expect(markup).toContain(`data-answer-refusal="${key}"`);
      expect(markup).toContain((en.challenge.answer.refusals as Record<string, string>)[key].replace(/'/g, "&#x27;"));
    }
    expect(form({ text: "abc" })).toContain("3,997 left");
  });
});

describe("L28: a decision counts only when it says what the registry says, and links its reasons only as ipfs://<cid>", () => {
  const published = (upheld: boolean, reasonsURI = `ipfs://${CID}`): DecisionRead => ({
    kind: "published",
    decision: { upheld, reasonsURI, publishedAt: OPENED_AT + 90_000 },
  });

  it("is nothing for a dispute still open", () => {
    expect(decisionView({ status: 1 }, published(true), null)).toBeNull();
  });

  it("links the reasons of a decision that matches the registry, dated by the settle", () => {
    const view = decisionView({ status: 2 }, published(true), OPENED_AT + 80_000);
    expect(view).toEqual({
      outcome: "upheld",
      date: OPENED_AT + 80_000,
      reasons: { kind: "link", href: `https://gateway.pinata.cloud/ipfs/${CID}`, uri: `ipfs://${CID}` },
    });
    const markup = render(createElement(DecisionBlock, { view: view as NonNullable<typeof view> }));
    expect(markup).toContain('id="decision"');
    expect(markup).toContain("Upheld on Sep 22, 2026. Moolam agreed with the challenge.");
    expect(markup).toContain(`href="https://gateway.pinata.cloud/ipfs/${CID}"`);
    expect(markup).toContain("Read the reasons");
  });

  it("drops a published decision whose outcome disagrees with the registry", () => {
    expect(decisionView({ status: 3 }, published(true), null)?.reasons).toEqual({ kind: "none" });
    expect(render(createElement(DecisionBlock, { view: decisionView({ status: 3 }, published(true), OPENED_AT)! }))).toContain(
      "No reasons were published with this decision.",
    );
  });

  it("prints any other address as text and follows none of it", () => {
    for (const uri of ["https://evil.example/reasons", `ipfs://${CID}/../x`, "ipfs://short", `ipfs://${CID}?q=1`]) {
      const view = decisionView({ status: 3 }, published(false, uri), OPENED_AT)!;
      expect(view.reasons, uri).toEqual({ kind: "text", uri });
      const markup = render(createElement(DecisionBlock, { view }));
      expect(markup).not.toContain("href=");
      expect(markup).toContain("Rejected on");
    }
  });

  it("says a reasons read that failed in words, and dates from the publish when nothing else is known", () => {
    expect(render(createElement(DecisionBlock, { view: decisionView({ status: 2 }, { kind: "failed" }, null)! }))).toContain(
      "Upheld. Moolam agreed with the challenge.",
    );
    expect(render(createElement(DecisionBlock, { view: decisionView({ status: 2 }, { kind: "failed" }, null)! }))).toContain(
      "could not be read just now",
    );
    expect(decisionView({ status: 3 }, published(false), null)?.date).toBe(OPENED_AT + 90_000);
  });
});

describe("L29: the challenger's evidence address is a link only as ipfs://<cid>", () => {
  const record = (uri: string) =>
    render(
      createElement(ChallengeRecord, { passportId: PASSPORT, dispute: dispute(), evidence: { reason: null, uri }, answer: { kind: "none" } }),
    );

  it("holds the pinned rule to ipfs:// and a content id, nothing else", () => {
    expect(pinnedLink(`ipfs://${CID}`)).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
    for (const uri of ["https://evil.example", "javascript:alert(1)", `ipfs://${CID}/path`, "ipfs://", `IPFS://${CID}`, `data:text/plain,x`]) {
      expect(pinnedLink(uri), uri).toBeNull();
    }
  });

  it("draws an https address as text with no link", () => {
    const markup = record("https://evil.example/proof");
    expect(markup).toContain("data-evidence-text");
    expect(markup).toContain("https://evil.example/proof");
    expect(markup).not.toContain('href="https://evil.example');
  });

  it("links an ipfs address through the gateway", () => {
    const markup = record(`ipfs://${CID}`);
    expect(markup).toContain(`href="https://gateway.pinata.cloud/ipfs/${CID}"`);
    expect(markup).toContain("data-evidence-link");
  });
});

describe("the flag panel's rules and the bond line", () => {
  function flag(treasury: Hex | null): FlagPassport {
    return {
      ready: true,
      authenticated: true,
      isOwner: false,
      wallet: stranger.address,
      reading: false,
      bond: parseEther("1"),
      balance: parseEther("3"),
      check: { enough: true, shortfall: 0n },
      treasury,
      state: { ...initialFlagState, open: true },
      actions: { open: NOOP, close: NOOP, setReason: NOOP, submit: ASYNC_NOOP, recheck: ASYNC_NOOP, signIn: NOOP, reset: NOOP },
    };
  }
  const panel = (treasury: Hex | null) => {
    flagStub.current = flag(treasury);
    return render(createElement(Challenge, { passportId: PASSPORT, owner: holder.address, disputeOpen: false }));
  };

  it("lists what a challenge needs, the burden, and who decides, before the bond", () => {
    const markup = panel(null);
    for (const line of Object.values(en.challenge.rules)) {
      expect(markup).toContain(line.replace(/'/g, "&#x27;"));
    }
    expect(markup).toContain(en.challenge.decider.who);
    expect(markup).toContain(en.challenge.decider.seat);
    expect(markup.indexOf("What a challenge needs")).toBeLessThan(markup.indexOf("Flag with 1 MON"));
  });

  it("says the bond is burned only when the policy's treasury is the burn address", () => {
    expect(bondFate(BURN_ADDRESS)).toBe("burned");
    expect(bondFate(BURN_ADDRESS.toLowerCase() as Hex)).toBe("burned");
    const burned = panel(BURN_ADDRESS);
    expect(burned).toContain('data-bond-fate="burned"');
    expect(burned).toContain("is burned, so Moolam gains nothing");
  });

  it("names the treasury instead while it is any other address, and says nothing before it is read", () => {
    const deployer = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
    const credited = panel(deployer);
    expect(credited).toContain('data-bond-fate="treasury"');
    expect(credited).toContain("credited to the treasury the policy names, ");
    expect(credited).toContain("0x559F35");
    expect(credited).not.toContain("burned");
    const unread = panel(null);
    expect(unread).not.toContain("data-bond-fate");
    expect(unread).not.toContain("burned");
  });
});

describe("My pictures: the challenges a wallet holds", () => {
  it("draws each challenged picture with the claim, its link and the holder's side", () => {
    answerStub.current = {
      ready: true,
      isHolder: true,
      text: "",
      phase: "idle",
      refusal: null,
      answerURI: null,
      sent: null,
      setText: NOOP,
      submit: ASYNC_NOOP,
    };
    const markup = render(
      createElement(ChallengedList, {
        rows: [
          {
            passportId: PASSPORT,
            challenger: CHALLENGER,
            openedAt: OPENED_AT,
            reason: "The same file is on a stock library from 2019.",
            title: "Tea train at dawn",
            answer: { kind: "waiting", until: OPENED_AT + 14 * 86_400 },
          },
        ],
      }),
    );
    expect(markup).toContain("A picture you hold is challenged");
    expect(markup).toContain(`/passport/${PASSPORT}`);
    expect(markup).toContain("The same file is on a stock library from 2019.");
    expect(markup).toContain("Tea train at dawn");
    // Before the wallet is up the holder reads the same waiting line everybody does.
    expect(markup).toContain("They have until");
  });
});
