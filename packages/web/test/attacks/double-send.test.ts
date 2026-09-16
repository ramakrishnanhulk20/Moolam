// Attack 3 of the second attack pass: the send is out, Monad has not shown it, and the creator
// presses the button again. A second send here is a second passport for one picture, or a second
// passkey written over the one the first transaction is about to bind.
// This runs on the reducers and the flow helpers alone, with no browser and no network, plus a
// read of the two screens that decide whether the button can be pressed at all.
// Does NOT cover the rendered React components or Privy's own retry behaviour. What the registry
// does with a duplicate is the PassportAlreadyExists refusal, executed on mainnet by
// packages/agents/scripts/prove.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { registerCalldata, type PassportInput } from "@/lib/chain/calldata";
import { assertionToAuth, challengeFromDigest } from "@/lib/passkey/webauthn";
import { bindReducer, initialBindState } from "@/lib/studio/binding";
import { initialRegisterState, isBusy, isRegistered, isUnconfirmed, registerReducer } from "@/lib/studio/flow";
import { isResendable, type Failure } from "@/lib/studio/problems";
import { buildAssertion, makeP256Key } from "../fixtures";

const DIGEST = "0x9b1f2c3d4e5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" as Hex;
const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;

const INPUT: PassportInput = {
  exactHash: `0x${"ab".repeat(32)}`,
  parentId: `0x${"00".repeat(32)}`,
  creator: CREATOR,
  generatorAgentId: 0n,
  phash: 17297841240124424192n,
  blockhash256: `0x${"cd".repeat(32)}`,
  manifestHash: `0x${"00".repeat(32)}`,
  kind: 0,
  fingerprintVersion: 1,
  metadataURI: "ipfs://bafkreimine",
  deadline: 1_788_878_342n,
};

const TIMED_OUT: Failure = { key: "confirmPending", next: "recheck" };
const CANCELLED: Failure = { key: "sendCancelled", next: "again" };

/** One fixed assertion, so two calldata builds over it can be compared byte for byte. */
const auth = {
  authenticatorData: `0x${"33".repeat(37)}` as Hex,
  clientDataJSON: '{"type":"webauthn.get","challenge":"abc","origin":"http://localhost:3210"}',
  challengeIndex: 23n,
  typeIndex: 1n,
  r: `0x${"11".repeat(32)}` as Hex,
  s: `0x${"22".repeat(32)}` as Hex,
};

/** The register screen after a send that Monad has not shown yet. */
function afterTimeout() {
  let state = registerReducer(initialRegisterState, {
    type: "choose",
    file: new File(["x"], "p.jpg", { type: "image/jpeg" }),
  });
  state = registerReducer(state, { type: "start", step: "send" });
  return registerReducer(state, { type: "failed", failure: TIMED_OUT, stage: "confirm" });
}

/**
 * The branch registerImage takes when the button is pressed a second time: a refusal from before
 * the send sends the bytes that are already signed, and nothing else reaches the passkey.
 */
function pressAgain(
  failure: Failure,
  pending: { kind: "register"; data: Hex } | null,
  send: (data: Hex) => void,
  sign: () => void,
): void {
  if (isResendable(failure) && pending?.kind === "register") {
    send(pending.data);
    return;
  }
  sign();
}

const studio = readFileSync(fileURLToPath(new URL("../../lib/studio/useStudio.ts", import.meta.url)), "utf8");

describe("a second send while the first is unconfirmed", () => {
  it("leaves the whole register screen busy, which is what shuts the button", () => {
    const state = afterTimeout();

    expect(state.steps.send).toBe("unconfirmed");
    expect(isBusy(state)).toBe(true);
    expect(isUnconfirmed(state)).toBe(true);
    expect(isRegistered(state)).toBe(false);
  });

  it("offers a recheck and never a resend, because the bytes may already be on chain", () => {
    const state = afterTimeout();

    expect(state.failure?.next).toBe("recheck");
    expect(isResendable(state.failure)).toBe(false);
  });

  it("locks the bind card in the same way, so no second passkey is made over the first", () => {
    const bound = bindReducer({ ...initialBindState, stage: "sending" }, { type: "failed", failure: TIMED_OUT });

    expect(bound.stage).toBe("unconfirmed");
    expect(bound.failure?.next).toBe("recheck");

    const card = readFileSync(fileURLToPath(new URL("../../components/studio/BindCard.tsx", import.meta.url)), "utf8");
    expect(card).toContain('state.stage === "unconfirmed"');
    expect(card).toContain("disabled={busy}");
  });

  it("is shut on both panels by the same helper, not by a flag each screen keeps", () => {
    for (const name of ["RegisterPanel", "GeneratePanel"]) {
      const panel = readFileSync(fileURLToPath(new URL(`../../components/studio/${name}.tsx`, import.meta.url)), "utf8");
      expect(panel).toContain("const busy = isBusy(state)");
      expect(panel).toContain("disabled={busy");
    }
  });

  it("answers a bind pressed twice with the recheck, before a passkey is created", () => {
    const body = studio.slice(studio.indexOf("const bindThisDevice = useCallback"));
    const guard = body.indexOf('watching.current?.kind === "bind"');
    const made = body.indexOf("await createPasskey(");

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(made);
    expect(body.slice(guard, made)).toContain('key: "confirmPending"');
  });
});

describe("the resend path, for a refusal from before the send", () => {
  it("sends the bytes that were already signed and never prompts again", () => {
    const send = vi.fn();
    const sign = vi.fn();
    const kept = { kind: "register" as const, data: registerCalldata(INPUT, auth) };

    pressAgain(CANCELLED, kept, send, sign);

    expect(send).toHaveBeenCalledWith(kept.data);
    expect(sign).not.toHaveBeenCalled();
  });

  it("would be a different transaction if it signed again, which is why the bytes are kept", async () => {
    const key = await makeP256Key();
    const challenge = challengeFromDigest(DIGEST);

    const once = registerCalldata(INPUT, assertionToAuth(await buildAssertion(key, challenge)));
    const twice = registerCalldata(INPUT, assertionToAuth(await buildAssertion(key, challenge)));

    expect(once).not.toBe(twice);
    expect(registerCalldata(INPUT, auth)).toBe(registerCalldata(INPUT, auth));
  });

  it("is the branch the studio takes, ahead of anything that would prompt", () => {
    const body = studio.slice(studio.indexOf("const registerImage = useCallback"));
    const resend = body.indexOf("sendRegister(pending.current.data, pending.current.exactHash");
    const prompt = body.indexOf("await signDigest(");

    expect(resend).toBeGreaterThan(-1);
    expect(resend).toBeLessThan(prompt);
    expect(body.slice(0, resend)).toContain("isResendable(register.failure)");
  });
});
