import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { decideSealed, type SealedAnswer } from "@/lib/sealed/handback";
import { holdsUnsavedFile, initialRegisterState, registerReducer } from "@/lib/studio/flow";
import type { PrepareResponse } from "@/lib/verifier/client";

const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, ...Array.from({ length: 200 }, (_, at) => (at * 13) % 253)]);
const ID = `0x${createHash("sha256").update(PICTURE).digest("hex")}` as const;

const SIGNED_FILE = {
  name: "monsoon-nets-9a8b7c6d.jpg",
  type: "image/jpeg",
  bytes: Buffer.from(PICTURE).toString("base64"),
  sha256: ID,
};

const SEALED: SealedAnswer = { sealed: true, signedFile: SIGNED_FILE, passport: { exactHash: ID } };
const PUBLISHED: SealedAnswer = { passport: { exactHash: ID } };

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

describe("the gate in front of the passkey prompt", () => {
  it("lets a published registration through with nothing to hold", async () => {
    expect(await decideSealed(PUBLISHED, false)).toEqual({ next: "sign", file: null });
  });

  it("holds the file, and only then says sign", async () => {
    const decision = await decideSealed(SEALED, true);
    expect(decision.next).toBe("sign");
    if (decision.next !== "sign" || decision.file === null) {
      throw new Error("a sealed answer that checks out has a file to hold");
    }
    expect(decision.file.name).toBe("monsoon-nets-9a8b7c6d.jpg");
    expect(decision.file.sha256).toBe(ID);
  });

  it("stops on one tampered byte, with nothing to sign", async () => {
    const tampered = Uint8Array.from(PICTURE);
    tampered[3] ^= 0x20;

    const decision = await decideSealed(
      { ...SEALED, signedFile: { ...SIGNED_FILE, bytes: Buffer.from(tampered).toString("base64") } },
      true,
    );

    expect(decision).toEqual({ next: "stop", failure: "sealedMismatch" });
    expect("file" in decision).toBe(false);
  });

  it("stops when a sealed registration comes back with no file at all", async () => {
    expect(await decideSealed(PUBLISHED, true)).toEqual({ next: "stop", failure: "sealedNotHeld" });
    expect(await decideSealed({ sealed: true, passport: { exactHash: ID } }, true)).toEqual({
      next: "stop",
      failure: "sealedNotHeld",
    });
  });

  /**
   * The gate is only a gate if it runs first. Both flows are read here rather
   * than driven, because a passkey ceremony cannot be opened from a test: what
   * can be proved is that no line asks for a signature before the check.
   */
  it("is called before the passkey on both paths, and nothing signs before it", () => {
    const hook = source("lib/studio/useStudio.ts");
    for (const flow of ["registerImage", "generateImage"]) {
      const from = hook.indexOf(`const ${flow} = useCallback`);
      const to = hook.indexOf("}, [", from);
      const body = hook.slice(from, to);
      expect(body, flow).toContain("holdSealedFile");
      expect(body.indexOf("holdSealedFile"), flow).toBeLessThan(body.indexOf("signDigest"));
    }
    // One place decides, so there is one place to read the rule from.
    expect(hook.split("decideSealed(").length - 1).toBe(1);
  });
});

describe("what the register screen remembers about sealing", () => {
  const picture = new File(["x"], "picture.jpg", { type: "image/jpeg" });

  it("opens with the switch off and nothing held", () => {
    expect(initialRegisterState.sealed).toEqual({
      on: false,
      includePrompt: false,
      privateRecheck: false,
      file: null,
      saved: false,
    });
    expect(holdsUnsavedFile(initialRegisterState)).toBe(false);
  });

  it("keeps the creator's answer across another picture, a switch of path and a new run", () => {
    let state = registerReducer(initialRegisterState, { type: "sealed", on: true });
    state = registerReducer(state, { type: "includePrompt", include: true });

    for (const action of [
      { type: "choose", file: picture },
      { type: "mode", mode: "generate" },
      { type: "reset" },
    ] as const) {
      const after = registerReducer(state, action);
      expect(after.sealed.on, action.type).toBe(true);
      expect(after.sealed.includePrompt, action.type).toBe(true);
    }
  });

  it("drops a held file the moment a new run starts, so no stale copy is offered", () => {
    let state = registerReducer(initialRegisterState, { type: "sealed", on: true });
    state = registerReducer(state, { type: "sealedFile", file: held() });
    expect(state.sealed.file).not.toBeNull();

    expect(registerReducer(state, { type: "reset" }).sealed.file).toBeNull();
    expect(registerReducer(state, { type: "choose", file: picture }).sealed.file).toBeNull();
  });

  it("warns while the only copy is unsaved, and stops once it is on disk", () => {
    let state = registerReducer(initialRegisterState, { type: "sealed", on: true });
    state = registerReducer(state, { type: "sealedFile", file: held() });
    expect(holdsUnsavedFile(state)).toBe(true);

    state = registerReducer(state, { type: "sealedSaved" });
    expect(state.sealed.saved).toBe(true);
    expect(holdsUnsavedFile(state)).toBe(false);

    // A second file, from a second run, is unsaved again.
    state = registerReducer(state, { type: "sealedFile", file: held() });
    expect(holdsUnsavedFile(state)).toBe(true);
  });

  it("keeps the file and the statement apart: registering does not touch either", () => {
    let state = registerReducer(initialRegisterState, { type: "sealed", on: true });
    state = registerReducer(state, { type: "sealedFile", file: held() });
    state = registerReducer(state, { type: "sealedSaved" });
    state = registerReducer(state, { type: "prepared", prepared: { passport: { exactHash: ID } } as PrepareResponse });
    state = registerReducer(state, { type: "confirmed", block: 7n, at: 1_788_876_542_000 });

    expect(state.sealed.file).not.toBeNull();
    expect(state.sealed.saved).toBe(true);
  });
});

function held() {
  return {
    name: "monsoon-nets-9a8b7c6d.jpg",
    type: "image/jpeg",
    blob: new Blob([PICTURE as BlobPart], { type: "image/jpeg" }),
    sha256: ID,
    size: PICTURE.length,
  };
}
