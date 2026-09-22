import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { BindCard } from "@/components/studio/BindCard";
import { IdentityStrip } from "@/components/studio/IdentityStrip";
import { RecoverCard } from "@/components/studio/RecoverCard";
import { SignedOut } from "@/components/studio/SignedOut";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { PathChoice } from "@/components/studio/PathChoice";
import { Receipt } from "@/components/studio/Receipt";
import { YourPassports } from "@/components/studio/YourPassports";
import type { Studio } from "@/lib/studio/useStudio";
import { initialRegisterState, type RegisterState } from "@/lib/studio/flow";
import type { GenerateResponse, PrepareResponse } from "@/lib/verifier/client";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing these cards use from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

/**
 * The cards a creator meets before any transaction, rendered for real in both
 * languages. This does not click anything: it proves the markup builds and
 * every string it asks for exists, which is what a missing message key or a
 * broken prop would break first.
 */
function render(locale: "en" | "ta", node: ReactElement): string {
  // The provider's own props type demands children, which createElement passes
  // as an argument rather than a prop.
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

const NOOP = () => undefined;

/** The opening tag of the element a label sits in, so a disabled button is read off the button itself. */
function tagBefore(markup: string, label: string): string {
  const at = markup.indexOf(label);
  expect(at).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<", at), at);
}

describe("the cards before the first transaction", () => {
  it("renders the signed out card in both languages", () => {
    const english = render("en", createElement(SignedOut, { onSignIn: NOOP }));
    expect(english).toContain("Sign in and create my account");
    expect(english).toContain("no seed phrase to write down");

    // The choice a creator gets over AI use is named before they sign in, not
    // found for the first time in the middle of a form.
    expect(english).toContain(en.studio.signedOut.points.consent.label);
    expect(english).toContain("open to AI, not for AI training, or ask me first");

    const tamil = render("ta", createElement(SignedOut, { onSignIn: NOOP }));
    expect(tamil).toContain("உள்நுழைந்து கணக்கை உருவாக்கு");
    expect(tamil).toContain(ta.studio.signedOut.points.consent.label);
  });

  it("renders the bind card at every stage it can be in", () => {
    for (const stage of ["idle", "creating", "waiting", "sending", "bound"] as const) {
      const markup = render(
        "en",
        createElement(BindCard, {
          state: { stage, qx: null, qy: null, txHash: `0x${"11".repeat(32)}`, failure: null },
          onBind: NOOP,
        }),
      );
      expect(markup.length).toBeGreaterThan(0);
    }

    const waiting = render(
      "en",
      createElement(BindCard, {
        state: { stage: "waiting", qx: null, qy: null, txHash: null, failure: null },
        onBind: NOOP,
      }),
    );
    expect(waiting).toContain("Waiting for your fingerprint or face unlock");
  });

  it("names the chain state it is watching, and falls back to the account link with no hash", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

    const watching = render(
      "en",
      createElement(BindCard, {
        state: { stage: "sending", qx: null, qy: null, txHash: null, failure: null },
        confirming: true,
        wallet,
        onBind: NOOP,
      }),
    );
    expect(watching).toContain("Waiting for Monad to record your passkey");

    const bound = render(
      "en",
      createElement(BindCard, {
        state: { stage: "bound", qx: null, qy: null, txHash: null, failure: null },
        wallet,
        onBind: NOOP,
      }),
    );
    expect(bound).toContain(`https://monadvision.com/address/${wallet}`);
    expect(bound).toContain("on MonadVision");
  });

  it("shows a failure with the one thing to do next", () => {
    const markup = render(
      "en",
      createElement(BindCard, {
        state: {
          stage: "idle",
          qx: null,
          qy: null,
          txHash: null,
          failure: { key: "passkeyCancelled", reason: "NotAllowedError", next: "again" },
        },
        onBind: NOOP,
      }),
    );
    expect(markup).toContain("The unlock prompt was closed or it timed out");
    expect(markup).toContain("Try again");
  });

  it("keeps the bind button shut while a bind is out, and offers the recheck", () => {
    const markup = render(
      "en",
      createElement(BindCard, {
        state: {
          stage: "unconfirmed",
          qx: null,
          qy: null,
          txHash: null,
          failure: { key: "confirmPending", next: "recheck" },
        },
        onBind: NOOP,
        onRecheck: NOOP,
      }),
    );
    expect(tagBefore(markup, "Use this device&#x27;s unlock")).toContain('disabled=""');
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain("nothing has been sent a second time");
  });

  it("offers a way out of the bind card when binding was a choice", () => {
    const state = { stage: "idle", qx: null, qy: null, txHash: null, failure: null } as const;

    const detour = render("en", createElement(BindCard, { state, rebind: true, onBind: NOOP, onCancel: NOOP }));
    expect(detour).toContain("Not now");

    const onlyWayIn = render("en", createElement(BindCard, { state, onBind: NOOP }));
    expect(onlyWayIn).not.toContain(">Not now<");
  });

  it("says what a digest the registry disagrees with means, in its own words", () => {
    const markup = render(
      "en",
      createElement(BindCard, {
        state: {
          stage: "idle",
          qx: null,
          qy: null,
          txHash: null,
          failure: { key: "digestMismatch", reason: "hash 0xab != 0xcd" },
        },
        onBind: NOOP,
      }),
    );
    expect(markup).toContain("a different record than the one on this page, so nothing was signed");
    expect(markup).not.toContain("Something went wrong before anything was sent");
  });

  it("says a register pressed before the passkey was read is only early", () => {
    const markup = render(
      "en",
      createElement(BindCard, {
        state: {
          stage: "idle",
          qx: null,
          qy: null,
          txHash: null,
          failure: { key: "passkeyNotReady", next: "again" },
        },
        onBind: NOOP,
      }),
    );
    expect(markup).toContain("has not finished reading your passkey from Monad");
    expect(markup).toContain("Try again");
  });

  it("renders the recovery card for a passkey on another device", () => {
    const markup = render(
      "en",
      createElement(RecoverCard, { busy: true, failure: null, onRecover: NOOP, onBindInstead: NOOP }),
    );
    expect(markup).toContain("Your passkey was set up somewhere else");
    expect(markup).toContain("Waiting for your fingerprint or face unlock");
  });

  it("says who is paying the fee, and only claims it is proven once it is", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;

    const claimed = render(
      "en",
      createElement(IdentityStrip, {
        account: { kind: "email", value: "ram@example.com" },
        wallet,
        sponsorship: "claimed",
        onSignOut: NOOP,
      }),
    );
    expect(claimed).toContain("Paid by Moolam through Privy");
    expect(claimed).toContain("ram@example.com");
    expect(claimed).toContain("Monad mainnet, chain 143");

    const proven = render(
      "en",
      createElement(IdentityStrip, {
        account: { kind: "passkey" },
        wallet,
        sponsorship: "proven",
        onSignOut: NOOP,
      }),
    );
    expect(proven).toContain("Your balance did not move");
    expect(proven).toContain("a passkey, with no email on file");
  });

  it("says the device signed it once a passkey is bound, and not before", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
    const strip = (passkey: boolean) =>
      render(
        "en",
        createElement(IdentityStrip, {
          account: { kind: "email", value: "ram@example.com" },
          wallet,
          sponsorship: "proven" as const,
          passkey,
          onSignOut: NOOP,
        }),
      );

    expect(strip(true)).toContain("Signed with this device&#x27;s own key, no seed phrase.");
    expect(strip(false)).not.toContain("no seed phrase");
  });
});

const PREPARED = {
  passport: {
    exactHash: `0x${"ab".repeat(32)}`,
    parentId: `0x${"00".repeat(32)}`,
    generatorAgentId: "0",
    phash: "7840506850305415717",
    blockhash256: `0x${"11".repeat(32)}`,
    manifestHash: `0x${"22".repeat(32)}`,
    kind: 1,
    fingerprintVersion: 1,
    metadataURI: "ipfs://metadata",
  },
  image: { cid: "cid", uri: "ipfs://image", gatewayUrl: "https://gateway/image", bytes: 10, width: 1600, height: 1200 },
  thumbnail: { cid: "thumb", uri: "ipfs://thumb", gatewayUrl: "https://gateway/thumb" },
  metadata: { cid: "meta", uri: "ipfs://metadata" },
  manifest: { embedded: true },
  preparedBy: "did:privy:someone",
} as unknown as PrepareResponse;

describe("the register panel", () => {
  const handlers = {
    onChoose: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onRegister: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  };

  it("opens with the three steps written out before anything runs", () => {
    const markup = render("en", createElement(RegisterPanel, { state: initialRegisterState, ...handlers }));
    expect(markup).toContain("Drop an image here");
    expect(markup).toContain("Fingerprint and pin the file, about ten seconds");
    expect(markup).toContain("Sign it with your unlock");
    expect(markup).toContain("Send it to Monad, network fee sponsored");
  });

  it("names what it is waiting for while the passkey step runs", () => {
    const state = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "running", send: "waiting" },
      prepared: PREPARED,
    } as RegisterState;
    const markup = render("en", createElement(RegisterPanel, { state, ...handlers }));
    expect(markup).toContain("Waiting for your fingerprint or face unlock");
    expect(markup).toContain("Fingerprinted, manifest embedded, pinned to IPFS");
  });

  it("says what it is watching while Monad is asked for the passport", () => {
    const state = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "running" },
      prepared: PREPARED,
      confirming: true,
    } as RegisterState;
    const markup = render("en", createElement(RegisterPanel, { state, ...handlers }));
    expect(markup).toContain("Waiting for Monad to record the passport");
    expect(markup).not.toContain("Sending to Monad, network fee sponsored");
  });

  it("offers a second look at Monad, never a second send, when the wait runs out", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
    const state = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "unconfirmed" },
      prepared: PREPARED,
      failure: { key: "confirmPending", next: "recheck", address: wallet },
    } as RegisterState;
    const markup = render("en", createElement(RegisterPanel, { state, wallet, ...handlers, onRecheck: NOOP }));
    expect(markup).toContain("nothing has been sent a second time");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain("Sent, and Monad has not shown it yet");
    expect(markup).not.toContain("It did not reach Monad");
    expect(markup).toContain(`https://monadvision.com/address/${wallet}`);
    expect(markup).not.toContain("pay the fee myself");
  });

  it("paints a timed out wait as pending, never as the failure red", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
    const timedOut = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "unconfirmed" },
      prepared: PREPARED,
      failure: { key: "confirmPending", next: "recheck", address: wallet },
    } as RegisterState;
    const waiting = render("en", createElement(RegisterPanel, { state: timedOut, wallet, ...handlers, onRecheck: NOOP }));
    expect(waiting).toContain('data-step="send" data-tone="pending"');
    expect(waiting).toContain("border border-text-muted bg-transparent");
    expect(waiting).toContain('role="status"');
    expect(waiting).not.toContain("failed");

    const broken = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "failed" },
      prepared: PREPARED,
      failure: { key: "sendFailed", reason: "the node refused it", next: "again" },
    } as RegisterState;
    const red = render("en", createElement(RegisterPanel, { state: broken, ...handlers }));
    expect(red).toContain('data-step="send" data-tone="failed"');
    expect(red).toContain("bg-failed");
    expect(red).toContain('role="alert"');
    expect(red).not.toContain('data-tone="pending"');
  });

  it("shows the passport once it is written, with the block and the links", () => {
    const state = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "done" },
      prepared: PREPARED,
      digest: `0x${"cd".repeat(32)}`,
      txHash: `0x${"ef".repeat(32)}`,
      block: 103_059_393n,
      registeredAt: 1_788_876_542_000,
    } as RegisterState;
    const markup = render("en", createElement(RegisterPanel, { state, ...handlers }));
    expect(markup).toContain("This image now has a passport");
    expect(markup).toContain("103059393");
    expect(markup).toContain(`/passport/0x${"ab".repeat(32)}`);
    expect(markup).toContain("Paid by Moolam through Privy");
  });

  it("takes the register button off the screen while a send is out, and offers the recheck instead", () => {
    const wallet = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as const;
    const state = {
      ...initialRegisterState,
      file: new File(["x"], "a-morning.jpg", { type: "image/jpeg" }),
      title: "A morning",
      steps: { prepare: "done", sign: "done", send: "unconfirmed" },
      prepared: PREPARED,
      failure: { key: "confirmPending", next: "recheck", address: wallet },
    } as RegisterState;

    const markup = render("en", createElement(RegisterPanel, { state, wallet, ...handlers, onRecheck: NOOP }));
    // The form is folded into the band by now, so there is no button to press
    // rather than a button that says no.
    expect(markup).not.toContain("Register this image");
    expect(markup).toContain("Sent, and Monad has not shown it yet");
    expect(markup).toContain("Ask Monad again");
    expect(markup).not.toContain("pay the fee myself");
  });

  it("offers the three plates under the title, with silence spelled out", () => {
    const markup = render("en", createElement(RegisterPanel, { state: initialRegisterState, ...handlers }));
    expect(markup).toContain(en.studio.consent.heading);
    expect(markup).toContain(en.passport.consent.control.choices.open.title);
    expect(markup).toContain(en.passport.consent.control.choices.closed.title);
    expect(markup).toContain(en.passport.consent.control.choices.ask.title);
    expect(markup).toContain(en.passport.consent.control.byUse);
    expect(markup).toContain(en.studio.consent.hint);
    // Nothing is picked when the panel opens, so nothing is sent.
    expect(markup).not.toContain('aria-pressed="true"');
  });

  it("asks for the conditions before it will register a statement that needs them", () => {
    const asking = {
      ...initialRegisterState,
      file: new File(["x"], "a-morning.jpg", { type: "image/jpeg" }),
      title: "A morning",
      consent: {
        consent: {
          aiTraining: "constrained",
          aiGenerativeTraining: "constrained",
          aiInference: "constrained",
          dataMining: "constrained",
        },
        constraintInfo: "",
      },
    } as RegisterState;

    const markup = render("en", createElement(RegisterPanel, { state: asking, ...handlers }));
    expect(markup).toContain(en.studio.consent.needsConditions);
    expect(markup).toContain(en.passport.consent.control.conditionsLabel);
    expect(markup).toContain("0 of 256 bytes");
    expect(tagBefore(markup, "Register this image")).toContain('disabled=""');

    const said = render(
      "en",
      createElement(RegisterPanel, {
        state: { ...asking, consent: { ...asking.consent, constraintInfo: "ask hello@moolam.app" } },
        ...handlers,
      }),
    );
    expect(said).not.toContain(en.studio.consent.needsConditions);
    expect(tagBefore(said, "Register this image")).not.toContain('disabled=""');
  });

  it("offers the passport that already holds the image when the registry refuses a repeat", () => {
    const state = {
      ...initialRegisterState,
      steps: { prepare: "done", sign: "done", send: "failed" },
      prepared: PREPARED,
      failure: { key: "alreadyRegistered", reason: "PassportAlreadyExists", next: "openPassport" },
    } as RegisterState;
    const markup = render("en", createElement(RegisterPanel, { state, ...handlers }));
    expect(markup).toContain("This exact image is already registered");
    expect(markup).toContain(`/passport/0x${"ab".repeat(32)}`);
  });
});

const DRAWN = {
  passport: {
    ...PREPARED.passport,
    creator: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    generatorAgentId: "10249",
    kind: 0,
    deadline: "1788878733",
  },
  generatorSig: `0x${"cd".repeat(65)}`,
  image: PREPARED.image,
  thumbnail: PREPARED.thumbnail,
  metadata: PREPARED.metadata,
  manifest: { embedded: true },
  model: "gpt-image-1",
  agent: { id: "10249", wallet: "0xa37418c4047Fb6A42150D6E9Ddab77580Ddb9AFb" },
  quota: { used: 1, limit: 3, resetsAt: 1788961533 },
  preparedBy: "did:privy:someone",
} as unknown as GenerateResponse;

describe("the agent panel", () => {
  const handlers = {
    onPrompt: NOOP,
    onTitle: NOOP,
    onConsent: NOOP,
    onGenerate: NOOP,
    onReset: NOOP,
    onUnsponsored: NOOP,
    onBind: NOOP,
  };

  const generating = { ...initialRegisterState, mode: "generate" } as RegisterState;

  it("offers both ways in, in both languages", () => {
    const english = render("en", createElement(PathChoice, { mode: "upload", busy: false, onMode: NOOP }));
    expect(english).toContain("Upload a picture");
    expect(english).toContain("Make one with the agent");

    const tamil = render("ta", createElement(PathChoice, { mode: "generate", busy: false, onMode: NOOP }));
    expect(tamil.length).toBeGreaterThan(0);
  });

  it("opens with the prompt box, the examples and the five steps written out", () => {
    const markup = render("en", createElement(GeneratePanel, { state: generating, ...handlers }));
    expect(markup).toContain("The agent draws the picture, up to sixty seconds");
    expect(markup).toContain("The agent signs the passport with its own wallet");
    expect(markup).toContain("Sign the same passport with your unlock");
    expect(markup).toContain("Send it to Monad, network fee sponsored");
    expect(markup).toContain("0 of 600 characters");
    expect(markup).toContain("A fishing boat leaving a harbour at first light");
    // Neither signature has happened yet, so neither seal is filled.
    expect(markup).toContain('data-signed="false"');
    expect(markup).not.toContain('data-signed="true"');
  });

  it("names the wait honestly while the agent draws", () => {
    const state = {
      ...generating,
      prompt: "a fishing boat at first light",
      steps: { ...generating.steps, draw: "running" },
    } as RegisterState;
    const markup = render("en", createElement(GeneratePanel, { state, ...handlers }));
    expect(markup).toContain("The agent is drawing this");
  });

  it("shows the agent signature, its id and its wallet the moment the answer lands", () => {
    const state = {
      ...generating,
      steps: { ...generating.steps, draw: "done", pin: "done", agentSign: "done", sign: "running" },
      prepared: DRAWN,
      generated: DRAWN,
      quota: DRAWN.quota,
    } as RegisterState;
    const markup = render("en", createElement(GeneratePanel, { state, ...handlers }));
    expect(markup).toContain("Drawn by gpt-image-1");
    expect(markup).toContain("Pinned to IPFS");
    expect(markup).toContain("Signed by the agent");
    expect(markup).toContain("Agent 10249");
    expect(markup).toContain("Privy server wallet under a policy that allows only this");
    expect(markup).toContain("Waiting for your passkey");
    expect(markup).toContain("1 of 3 today");
    expect(markup).toContain('data-signed="true"');
  });

  it("fills the second seal once this device has signed", () => {
    const state = {
      ...generating,
      steps: { ...generating.steps, draw: "done", pin: "done", agentSign: "done", sign: "done", send: "running" },
      prepared: DRAWN,
      generated: DRAWN,
      digest: `0x${"cd".repeat(32)}`,
    } as RegisterState;
    const markup = render("en", createElement(GeneratePanel, { state, ...handlers }));
    expect(markup.match(/data-signed="true"/g)).toHaveLength(2);
    expect(markup).toContain("Sending to Monad, network fee sponsored");
  });

  it("ends on a receipt that names the kind, the agent and the model", () => {
    const state = {
      ...generating,
      steps: { ...generating.steps, draw: "done", pin: "done", agentSign: "done", sign: "done", send: "done" },
      prepared: DRAWN,
      generated: DRAWN,
      title: "First light",
      prompt: "a fishing boat at first light",
      digest: `0x${"cd".repeat(32)}`,
      txHash: `0x${"ef".repeat(32)}`,
      registeredAt: 1_788_876_542_000,
    } as RegisterState;
    const markup = render("en", createElement(GeneratePanel, { state, ...handlers }));
    expect(markup).toContain("An agent made this, and you both signed for it");
    expect(markup).toContain("Generated");
    expect(markup).toContain("gpt-image-1");
    expect(markup).toContain("/agent/10249");
    expect(markup).toContain(`/passport/0x${"ab".repeat(32)}`);
  });

  it("says what a refused prompt and a spent quota mean, and offers the right button", () => {
    const refused = {
      ...generating,
      steps: { ...generating.steps, draw: "failed" },
      failure: { key: "promptRefused", reason: "the safety system turned this prompt down" },
    } as RegisterState;
    const markup = render("en", createElement(GeneratePanel, { state: refused, ...handlers }));
    expect(markup).toContain("The model would not draw this prompt");
    expect(markup).toContain("the safety system turned this prompt down");

    const spent = {
      ...generating,
      steps: { ...generating.steps, draw: "failed" },
      quota: { used: 3, limit: 3, resetsAt: 1788961533 },
      failure: { key: "quotaReached" },
    } as RegisterState;
    const atLimit = render("en", createElement(GeneratePanel, { state: spent, ...handlers }));
    expect(atLimit).toContain("3 of 3 today");
    expect(atLimit).toContain("pictures are used up");
    expect(atLimit).toContain("You have had every picture the agent draws");
    // No retry button on a quota: there is nothing to retry until tomorrow.
    expect(atLimit).not.toContain("Make it again");

    const expired = {
      ...generating,
      steps: { ...generating.steps, draw: "done", pin: "done", agentSign: "done", sign: "done", send: "failed" },
      prepared: DRAWN,
      generated: DRAWN,
      failure: { key: "expired", reason: "SignatureExpired", next: "generateAgain" },
    } as RegisterState;
    const stale = render("en", createElement(GeneratePanel, { state: expired, ...handlers }));
    expect(stale).toContain("Make it again");
  });

  it("carries the same plates as the upload panel, in Tamil too", () => {
    const english = render("en", createElement(GeneratePanel, { state: generating, ...handlers }));
    expect(english).toContain(en.studio.consent.heading);
    expect(english).toContain(en.passport.consent.control.choices.closed.title);
    expect(english).toContain(en.studio.consent.hint);

    const tamil = render("ta", createElement(GeneratePanel, { state: generating, ...handlers }));
    expect(tamil).toContain(ta.studio.consent.heading);
    expect(tamil).toContain(ta.passport.consent.control.choices.closed.title);
  });

  it("renders the whole agent panel in Tamil", () => {
    const state = {
      ...generating,
      steps: { ...generating.steps, draw: "done", pin: "done", agentSign: "done", sign: "running" },
      prepared: DRAWN,
      generated: DRAWN,
      quota: DRAWN.quota,
    } as RegisterState;
    const markup = render("ta", createElement(GeneratePanel, { state, ...handlers }));
    expect(markup).toContain("gpt-image-1");
    expect(markup).toContain("10249");
    expect(markup.length).toBeGreaterThan(0);
  });
});

/**
 * A run that has landed, with the two things only a real send can produce: the
 * milliseconds this browser measured and the receipt the chain billed. A
 * passkey prompt cannot be driven from a test, so the stamps that follow one
 * are rendered from this.
 */
function registered(over: Partial<RegisterState> = {}): Studio {
  return {
    authenticated: true,
    account: { kind: "email", value: "ram@example.com" },
    wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
    binding: { status: "bound", passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } },
    bind: { txHash: `0x${"11".repeat(32)}` },
    register: {
      ...initialRegisterState,
      prepared: PREPARED,
      digest: `0x${"cd".repeat(32)}`,
      txHash: `0x${"ef".repeat(32)}`,
      block: 103_059_393n,
      registeredAt: 1_788_876_542_000,
      timing: { waitedMs: 1_842, sealedAfterMs: 2_000 },
      charge: { gasUsed: 657_778n, gasPrice: 102_000_000_000n },
      ...over,
    },
  } as unknown as Studio;
}

describe("the stub that fills as the creator moves", () => {
  it("stamps only what has actually happened", () => {
    const studio = {
      authenticated: true,
      account: { kind: "email", value: "ram@example.com" },
      wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
      binding: { status: "bound", passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } },
      bind: { txHash: `0x${"11".repeat(32)}` },
      register: {
        ...initialRegisterState,
        prepared: PREPARED,
        digest: `0x${"cd".repeat(32)}`,
        txHash: `0x${"ef".repeat(32)}`,
        block: 103_059_393n,
        registeredAt: 1_788_876_542_000,
      },
    } as unknown as Studio;

    const markup = render("en", createElement(Receipt, { studio }));
    expect(markup).toContain("ram@example.com");
    expect(markup).toContain("Passkey bound");
    expect(markup).toContain("1600 by 1200 pixels");
    expect(markup).toContain("Recorded in block 103059393");
    expect(markup).toContain("Network fee paid by Moolam through Privy");
  });

  it("names the block only once it is known, and says where it is coming from until then", () => {
    const studio = {
      authenticated: true,
      account: { kind: "email", value: "ram@example.com" },
      wallet: "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c",
      binding: { status: "bound", passkey: { qx: `0x${"aa".repeat(32)}`, qy: `0x${"bb".repeat(32)}` } },
      bind: { txHash: null },
      register: {
        ...initialRegisterState,
        prepared: PREPARED,
        txHash: null,
        block: null,
        registeredAt: 1_788_876_542_000,
      },
    } as unknown as Studio;

    const markup = render("en", createElement(Receipt, { studio }));
    expect(markup).toContain("Written to Monad");
    expect(markup).toContain("The block number comes from the index");
    expect(markup).not.toContain("Recorded in block");
  });

  it("puts the measured wait, the sealed block and the charge on the last stamp", () => {
    const markup = render("en", createElement(Receipt, { studio: registered() }));

    expect(markup).toContain("Confirmed on Monad in");
    expect(markup).toContain("1,842");
    expect(markup).toContain("ms");
    expect(markup).toContain("Measured in this browser");
    expect(markup).toContain("The block was sealed 2 seconds after you tapped.");
    expect(markup).toContain("Billed 657,778 gas, 0.0671 MON, paid by Moolam through Privy.");
    expect(markup).toContain("0.067093356 MON exactly.");
    // The sponsored send says what it saved the creator, on the stamp that
    // carries the transaction.
    expect(markup).toContain("It would have cost you 0.0671 MON.");
  });

  it("says under a second rather than rounding a fast block down to zero", () => {
    const studio = registered({ timing: { waitedMs: 1_180, sealedAfterMs: 420 } });
    const markup = render("en", createElement(Receipt, { studio }));
    expect(markup).toContain("The block was sealed under a second after you tapped.");
    expect(markup).not.toContain("0 seconds");
  });

  it("names the payer as the creator when they paid the fee themselves", () => {
    const markup = render("en", createElement(Receipt, { studio: registered({ unsponsored: true }) }));
    expect(markup).toContain("Billed 657,778 gas, 0.0671 MON, from your own balance.");
    expect(markup).not.toContain("It would have cost you");
  });

  it("stamps no speed and no charge when neither was measured", () => {
    const markup = render("en", createElement(Receipt, { studio: registered({ timing: null, charge: null }) }));
    expect(markup).toContain("Recorded in block 103059393");
    expect(markup).not.toContain("Confirmed on Monad in");
    expect(markup).not.toContain("Billed");
  });

  it("stamps the whole run in Tamil", () => {
    const markup = render("ta", createElement(Receipt, { studio: registered() }));
    expect(markup).toContain(ta.studio.receipt.confirmedIn);
    expect(markup).toContain("1,842");
  });

  it("says the statement was written, how long Monad took and who paid for it", () => {
    const markup = render(
      "en",
      createElement(Receipt, {
        studio: registered({
          statement: {
            state: "stated",
            sent: {
              consent: {
                aiTraining: "notAllowed",
                aiGenerativeTraining: "notAllowed",
                aiInference: "notAllowed",
                dataMining: "notAllowed",
              },
              constraintInfo: "",
            },
            hash: `0x${"3f".repeat(32)}`,
            at: 1_789_719_047,
            waitedMs: 1_204,
            sponsored: true,
            failure: null,
          },
        }),
      }),
    );

    expect(markup).toContain(en.studio.consent.receipt.label);
    expect(markup).toContain(en.passport.consent.summary.closed);
    expect(markup).toContain("Stated on Monad in 1,204 ms.");
    expect(markup).toContain(en.studio.consent.receipt.sponsored);
    expect(markup).toContain(`https://monadvision.com/tx/0x${"3f".repeat(32)}`);
  });

  it("prints the conditions on the stamp when the statement carries them", () => {
    const markup = render(
      "en",
      createElement(Receipt, {
        studio: registered({
          statement: {
            state: "stated",
            sent: {
              consent: {
                aiTraining: "constrained",
                aiGenerativeTraining: "constrained",
                aiInference: "constrained",
                dataMining: "constrained",
              },
              constraintInfo: "ask hello@moolam.app",
            },
            hash: null,
            at: 1_789_719_047,
            waitedMs: 980,
            sponsored: true,
            failure: null,
          },
        }),
      }),
    );

    expect(markup).toContain(en.passport.consent.summary.ask);
    expect(markup).toContain("Your conditions: ask hello@moolam.app");
  });

  it("names what it is doing while the statement is out, and offers only a second look", () => {
    const sending = render(
      "en",
      createElement(Receipt, {
        studio: registered({
          statement: { state: "sending", sent: null, hash: null, at: null, waitedMs: null, sponsored: false, failure: null },
        }),
      }),
    );
    expect(sending).toContain(en.studio.consent.receipt.sending);
    expect(sending).not.toContain(en.studio.consent.receipt.again);

    const unconfirmed = render(
      "en",
      createElement(Receipt, {
        studio: registered({
          statement: {
            state: "unconfirmed",
            sent: null,
            hash: `0x${"3f".repeat(32)}`,
            at: null,
            waitedMs: null,
            sponsored: false,
            failure: { key: "confirmPending", next: "recheck" },
          },
        }),
      }),
    );
    expect(unconfirmed).toContain(en.studio.consent.receipt.pending);
    expect(unconfirmed).toContain(en.studio.consent.receipt.recheck);
    expect(unconfirmed).not.toContain(en.studio.consent.receipt.again);
  });

  it("keeps the passport's own stamps when the statement failed, and offers it again", () => {
    const markup = render(
      "en",
      createElement(Receipt, {
        studio: registered({
          statement: {
            state: "failed",
            sent: null,
            hash: null,
            at: null,
            waitedMs: null,
            sponsored: false,
            failure: { key: "declined", next: "again" },
          },
        }),
      }),
    );

    expect(markup).toContain("Recorded in block 103059393");
    expect(markup).toContain(en.studio.consent.receipt.failed);
    expect(markup).toContain(en.passport.consent.failure.declined);
    expect(markup).toContain(en.studio.consent.receipt.later);
    expect(markup).toContain(en.studio.consent.receipt.again);
  });

  it("says in one quiet line when nothing was stated, and says silence is not permission", () => {
    const markup = render("en", createElement(Receipt, { studio: registered() }));
    expect(markup).toContain(en.studio.consent.receipt.none);
    expect(markup).toContain(en.studio.consent.receipt.noneDetail);
    expect(markup).not.toContain(en.studio.consent.receipt.again);
  });

  it("says plainly that nothing has happened yet", () => {
    const studio = {
      authenticated: false,
      account: { kind: "account" },
      wallet: undefined,
      binding: { status: "reading", passkey: null },
      bind: { txHash: null },
      register: initialRegisterState,
    } as unknown as Studio;

    expect(render("en", createElement(Receipt, { studio }))).toContain("Nothing yet");
  });
});

describe("the creator's own passports", () => {
  it("says the list is empty in words, never with a placeholder row", () => {
    const markup = render(
      "en",
      createElement(YourPassports, {
        passports: { status: "ready", passports: [], error: null, refresh: NOOP },
      }),
    );
    expect(markup).toContain("Nothing registered from this account yet");
    expect(markup).not.toContain("<img");
  });

  it("renders a row from the index with its thumbnail and its block", () => {
    const markup = render(
      "en",
      createElement(YourPassports, {
        passports: {
          status: "ready",
          error: null,
          refresh: NOOP,
          passports: [
            {
              id: `0x${"ab".repeat(32)}`,
              kind: 1,
              registeredAt: 1_788_876_542n,
              registeredBlock: 103_059_393n,
              metadataURI: "ipfs://metadata",
              title: "A morning",
              imageUrl: "https://gateway/thumb",
            },
          ],
        },
      }),
    );
    expect(markup).toContain("A morning");
    expect(markup).toContain("https://gateway/thumb");
    expect(markup).toContain("Captured");
  });
});
