import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import hi from "@/messages/hi.json";
import ja from "@/messages/ja.json";
import ko from "@/messages/ko.json";
import pt from "@/messages/pt.json";
import ta from "@/messages/ta.json";
import zh from "@/messages/zh.json";
import { registerReducer, initialRegisterState, type RegisterState } from "@/lib/studio/flow";
import { describeFailure, describeGenerateFailure } from "@/lib/studio/problems";
import { VerifierError } from "@/lib/verifier/client";

/**
 * The two buttons a failed agent run hands back (WO-311): the upload path for
 * an agent that cannot draw or a spent day, and the prompt for a refused
 * prompt. Held here: which failures carry them and which never do, what the
 * reducer keeps when the form comes back, and the two labels in all ten
 * languages. The press itself is driven in studio-agent-off-flow and
 * studio-agent-off-screen.
 */

const LANGS = { en, de, es, fr, hi, ja, ko, pt, ta, zh } as const;
const LONG_DASH = String.fromCharCode(0x2014);
const KEYS = ["openUpload", "editPrompt"] as const;

const QUOTA = { used: 3, limit: 3, resetsAt: 1_788_961_533 };

describe("which failures hand back a way on", () => {
  it("gives the upload path to a spent day and the prompt to a refused prompt, on the agent path", () => {
    const spent = new VerifierError("quota", 429, "quota", QUOTA);
    expect(describeGenerateFailure(spent)).toEqual({ key: "quotaReached", next: "openUpload" });

    const refused = new VerifierError("prompt-refused", 400, "the safety system said no");
    expect(describeGenerateFailure(refused)).toEqual({
      key: "promptRefused",
      reason: "the safety system said no",
      next: "editPrompt",
    });
  });

  it("does not offer the upload path on the upload path, where the word has the same sentence and nowhere to go", () => {
    const spent = new VerifierError("quota", 429, "quota", QUOTA);
    expect(describeFailure(spent, "prepare")).toEqual({ key: "quotaReached" });
  });

  it("leaves every failure that already had a retry on the retry it had", () => {
    const cases: [VerifierError, string][] = [
      [new VerifierError("model-failed", 502, "model-failed"), "again"],
      [new VerifierError("busy", 503, "busy"), "again"],
      [new VerifierError("offline", 0, "offline"), "again"],
      [new VerifierError("unauthorized", 401, "unauthorized"), "signIn"],
    ];
    for (const [error, next] of cases) {
      expect(describeGenerateFailure(error).next, error.code).toBe(next);
    }
  });
});

describe("the agent form coming back after a refused prompt", () => {
  const typed = {
    ...initialRegisterState,
    mode: "generate",
    title: "His Dream",
    prompt: "a fishing boat leaving a harbour at first light",
    sealed: { on: true, includePrompt: true, privateRecheck: true, file: null, saved: false },
    quota: { used: 1, limit: 3, resetsAt: 1_788_961_533 },
  } as RegisterState;

  it("clears the run and keeps everything the creator typed and chose", () => {
    let state = registerReducer(typed, { type: "start", step: "draw" });
    state = registerReducer(state, {
      type: "failed",
      failure: { key: "promptRefused", reason: "no", next: "editPrompt" },
      stage: "prepare",
    });
    expect(state.steps.draw).toBe("failed");
    expect(state.failure?.next).toBe("editPrompt");

    const reopened = registerReducer(state, { type: "reopen" });
    expect(reopened).toEqual(typed);
  });

  it("drops a drawing, a held file and a receipt, which belong to the run that ended", () => {
    const messy = {
      ...typed,
      generated: {} as RegisterState["generated"],
      prepared: {} as RegisterState["prepared"],
      digest: `0x${"cd".repeat(32)}`,
      txHash: `0x${"ef".repeat(32)}`,
      review: true,
      confirming: true,
      unsponsored: true,
      sealed: { ...typed.sealed, file: {} as RegisterState["sealed"]["file"], saved: true },
    } as RegisterState;

    const reopened = registerReducer(messy, { type: "reopen" });
    expect(reopened.generated).toBeNull();
    expect(reopened.prepared).toBeNull();
    expect(reopened.digest).toBeNull();
    expect(reopened.txHash).toBeNull();
    expect(reopened.review).toBe(false);
    expect(reopened.confirming).toBe(false);
    expect(reopened.unsponsored).toBe(false);
    expect(reopened.sealed.file).toBeNull();
    expect(reopened.sealed.saved).toBe(false);
    expect(reopened.prompt).toBe(typed.prompt);
  });
});

describe("the two button labels in every language", () => {
  const tongues = Object.entries(LANGS);

  it("are said in all ten, each as its own words", () => {
    expect(tongues).toHaveLength(10);
    for (const [lang, messages] of tongues) {
      for (const key of KEYS) {
        const said = messages.studio.actions[key];
        expect(typeof said, `${lang} ${key}`).toBe("string");
        expect(said.trim().length, `${lang} ${key}`).toBeGreaterThan(5);
        if (lang !== "en") {
          expect(said, `${lang} ${key}`).not.toBe(en.studio.actions[key]);
        }
      }
      expect(messages.studio.actions.openUpload, lang).not.toBe(messages.studio.actions.editPrompt);
    }
  });

  it("carry no placeholder, so no language can leave one open or drop one the others fill", () => {
    for (const [lang, messages] of tongues) {
      for (const key of KEYS) {
        expect(messages.studio.actions[key].match(/[{}]/g), `${lang} ${key}`).toBeNull();
      }
    }
  });

  it("format as written under the message library, which is what the screen runs", () => {
    for (const [lang, messages] of tongues) {
      const say = createTranslator({ locale: lang, messages: messages as never, namespace: "studio.actions" });
      for (const key of KEYS) {
        expect(say(key), `${lang} ${key}`).toBe(messages.studio.actions[key]);
      }
    }
  });

  it("hold no long dash, which is the one tell this house does not print", () => {
    for (const [lang, messages] of tongues) {
      for (const key of KEYS) {
        expect(messages.studio.actions[key].includes(LONG_DASH), `${lang} ${key}`).toBe(false);
      }
    }
  });
});
