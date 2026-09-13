import { describe, expect, it, vi } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import en from "@/messages/en.json";
import ta from "@/messages/ta.json";
import { initialEditState, type EditState } from "@/lib/passport/edit";
import type { PassportEdit } from "@/lib/passport/useEditPassport";

// The hook is where Privy lives, and Privy only runs in a browser. The panel is what this file
// tests, so the hook is replaced by a value each case sets for itself.
const stub = vi.hoisted(() => ({ current: null as unknown as PassportEdit }));

vi.mock("@/lib/passport/useEditPassport", () => ({
  useEditPassport: () => stub.current,
}));

// next-intl's navigation helpers reach for next/navigation, which only resolves inside the bundler.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
  useRouter: () => ({ refresh: () => undefined }),
}));

const { EditPanel } = await import("@/components/passport/EditPanel");

const PARENT = `0x${"3f".repeat(32)}` as const;
const CHILD = `0x${"ab".repeat(32)}` as const;
const OWNER = "0x551610a063BcAd79e6bd25dc55cEe92Ba3FD960a" as const;

const NOOP = () => undefined;
const ASYNC_NOOP = async () => undefined;

function edit(over: Partial<PassportEdit> = {}, state: Partial<EditState> = {}): PassportEdit {
  return {
    ready: true,
    isOwner: true,
    configured: true,
    wallet: OWNER,
    granted: false,
    granting: false,
    revoking: false,
    grantFailure: null,
    ...over,
    state: { ...initialEditState, ...state },
    actions: {
      grant: ASYNC_NOOP,
      revoke: ASYNC_NOOP,
      choose: NOOP,
      setTitle: NOOP,
      setNote: NOOP,
      submit: ASYNC_NOOP,
      recheck: ASYNC_NOOP,
      signIn: NOOP,
      reset: NOOP,
    },
  };
}

function render(locale: "en" | "ta", node: ReactElement): string {
  // The provider's own props type demands children, which createElement passes as an argument.
  const Provider = NextIntlClientProvider as unknown as FunctionComponent<{
    locale: string;
    messages: unknown;
    timeZone: string;
  }>;

  return renderToStaticMarkup(
    createElement(Provider, { locale, messages: locale === "en" ? en : ta, timeZone: "Asia/Kolkata" }, node),
  );
}

function panel(value: PassportEdit, locale: "en" | "ta" = "en"): string {
  stub.current = value;
  return render(locale, createElement(EditPanel, { parentId: PARENT, owner: OWNER }));
}

describe("who the panel draws itself for", () => {
  it("says nothing at all to a visitor who is signed out or signed in as someone else", () => {
    expect(panel(edit({ isOwner: false }))).toBe("");
    expect(panel(edit({ isOwner: false, granted: true }))).toBe("");
  });

  it("says nothing while Privy has not answered about the session yet", () => {
    expect(panel(edit({ ready: false }))).toBe("");
  });

  it("draws itself for the wallet that holds the passport", () => {
    expect(panel(edit())).toContain("Add an edited version");
  });

  it("says so plainly when this deployment has no signer id set", () => {
    const markup = panel(edit({ configured: false }));
    expect(markup).toContain("No signer is set up on this deployment");
    expect(markup).not.toContain("Allow edits from this app");
  });
});

describe("state one, before a signer is granted", () => {
  it("explains what a signer is, what the policy allows, and offers the one button", () => {
    const markup = panel(edit());
    expect(markup).toContain("A signer is a permission you give this app");
    expect(markup).toContain("appendEdit on the Moolam registry");
    expect(markup).toContain("Allow edits from this app");
    expect(markup).not.toContain("Drop the edited picture here");
  });

  it("says what is happening while Privy has the question", () => {
    expect(panel(edit({ granting: true }))).toContain("Privy is asking for your permission");
  });

  it("prints a refused grant in plain words", () => {
    const markup = panel(edit({ grantFailure: { key: "grantDeclined", next: "grant" } }));
    expect(markup).toContain("The permission was not given");
  });
});

describe("state two, with the signer granted", () => {
  it("offers the picture, the title and the note, and the way to take the permission back", () => {
    const markup = panel(edit({ granted: true }));
    expect(markup).toContain("Drop the edited picture here");
    expect(markup).toContain("What changed");
    expect(markup).toContain("280 left");
    expect(markup).toContain("Revoke");
    expect(markup).toContain("Add this edit");
  });

  it("names both steps before either has run", () => {
    const markup = panel(edit({ granted: true }));
    expect(markup).toContain("Pin the edited picture");
    expect(markup).toContain("Send it from your account");
  });

  it("says what is being waited on while the picture is being pinned", () => {
    const markup = panel(edit({ granted: true }, { steps: { pin: "running", send: "waiting" } }));
    expect(markup).toContain("Pinning the edited picture");
  });

  it("says the send went out from the owner's account under the policy", () => {
    const markup = panel(
      edit({ granted: true }, { steps: { pin: "done", send: "running" }, confirming: true }),
    );
    expect(markup).toContain("signed by the app&#x27;s key under the edit policy");
    expect(markup).toContain("Waiting for Monad to show it");
  });

  it("shows the allowance the service sent back", () => {
    const markup = panel(edit({ granted: true }, { quota: { used: 2, limit: 5, resetsAt: 1788961533 } }));
    expect(markup).toContain("2 of 5 edits today");
  });

  it("says all of it in Tamil too", () => {
    const markup = panel(edit({ granted: true }), "ta");
    expect(markup).toContain("திருத்திய படத்தை இங்கே இடுங்கள்");
    expect(markup).toContain("இந்தத் திருத்தத்தைச் சேர்");
  });
});

describe("every failure the panel can print", () => {
  const cases: [string, string][] = [
    ["noSigner", "does not hold a signer on your wallet"],
    ["notOwner", "does not hold this passport"],
    ["noParent", "no passport with this id"],
    ["pinFailed", "could not be pinned to IPFS"],
    ["busy", "as many edits at once as it can"],
    ["offline", "did not answer"],
    ["signedOut", "signed out"],
    ["tooLarge", "over the 20 MB limit"],
    ["notAnImage", "not an image file"],
    ["fileMissing", "Choose the edited picture first"],
    ["titleMissing", "Give the edit a title first"],
  ];

  for (const [key, sentence] of cases) {
    it(`says ${key} in words a reader can act on`, () => {
      const markup = panel(edit({ granted: true }, { failure: { key } }));
      expect(markup).toContain(sentence);
    });
  }

  it("counts the allowance into the quota sentence", () => {
    const markup = panel(
      edit({ granted: true }, { failure: { key: "quota" }, quota: { used: 5, limit: 5, resetsAt: 1788961533 } }),
    );
    expect(markup).toContain("That is 5 of 5 edits for today");
  });

  it("prints the registry's own reason under a refused send, with a retry", () => {
    const markup = panel(
      edit(
        { granted: true },
        {
          failure: { key: "sendFailed", reason: "PassportAlreadyExists", next: "again" },
          steps: { pin: "done", send: "failed" },
        },
      ),
    );
    expect(markup).toContain("The registry refused the edit");
    expect(markup).toContain("PassportAlreadyExists");
    expect(markup).toContain("Try again");
  });

  it("treats a send the service could not confirm as still out, not as a failure", () => {
    const markup = panel(
      edit(
        { granted: true },
        { failure: { key: "sendPending", next: "recheck" }, steps: { pin: "done", send: "failed" } },
      ),
    );
    expect(markup).toContain("it must not be sent again");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain('data-tone="pending"');
    expect(markup).not.toContain("Try again</button>");
  });

  it("offers a plain retry when a dependency did not answer and nothing was sent", () => {
    const markup = panel(
      edit({ granted: true }, { failure: { key: "dependencyDown", next: "later" }, steps: { pin: "failed", send: "waiting" } }),
    );
    expect(markup).toContain("nothing was sent and nothing was spent");
    expect(markup).toContain("Try again in a minute");
    expect(markup).toContain('data-tone="failed"');
  });

  it("never offers to send again when the wait ran out", () => {
    const markup = panel(
      edit(
        { granted: true },
        { failure: { key: "confirmPending", next: "recheck" }, steps: { pin: "done", send: "failed" } },
      ),
    );
    expect(markup).toContain("it must not be sent again");
    expect(markup).toContain("Ask Monad again");
    expect(markup).toContain('data-tone="pending"');
    expect(markup).not.toContain("Try again");
  });
});

describe("the receipt once the edit is on chain", () => {
  const result = {
    child: { exactHash: CHILD },
    hash: `0x${"1c".repeat(32)}`,
    image: { gatewayUrl: "https://gateway.pinata.cloud/ipfs/bafkreiedited" },
  } as never;

  it("links the child passport, names the block and says who paid", () => {
    const markup = panel(
      edit(
        { granted: true },
        {
          steps: { pin: "done", send: "done" },
          result,
          block: 41273109n,
          children: [CHILD],
          quota: { used: 1, limit: 5, resetsAt: 1788961533 },
        },
      ),
    );

    expect(markup).toContain(`/passport/${CHILD}`);
    expect(markup).toContain("41273109");
    expect(markup).toContain("Sponsored by Privy");
    expect(markup).toContain("Recorded");
    expect(markup).toContain("Add another edit");
  });
});
