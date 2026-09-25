"use client";

import { MotionConfig } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import {
  PICTURE,
  PICTURES_MADE,
  REGISTERED_AT,
  RUN,
  fixtureState,
  type Path,
} from "@/components/lab/studio/fixtures";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { initialBindState } from "@/lib/studio/binding";
import { isBusy, type RegisterState } from "@/lib/studio/flow";
import type { CreatorPassport, CreatorPassports } from "@/lib/studio/useCreatorPassports";
import type { Studio } from "@/lib/studio/useStudio";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { IdentityStrip } from "@/components/studio/IdentityStrip";
import { WideLayout } from "@/components/studio/layout";
import { PathChoice } from "@/components/studio/PathChoice";
import { Receipt } from "@/components/studio/Receipt";
import { RegisterPanel } from "@/components/studio/RegisterPanel";
import { StudioBox } from "@/components/studio/StudioFrame";
import { YourPassports } from "@/components/studio/YourPassports";
import { hasStarted, useStickyTop, useStudioPress } from "@/components/studio/press";

/** The three poses the fixture can draw without a wallet. */
export type WideFixtureName = "upload" | "generate" | "done";

const CREATOR = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const NOTHING = () => undefined;
const NOTHING_LATER = async () => undefined;

/**
 * The signed in studio drawn from stubbed state, for tests and for measuring on
 * a machine that cannot sign in. Nothing here reaches a wallet, the verify
 * service or Monad: every pose comes from the studio bench's own fixtures.
 *
 * It lives under test/ so no route can reach it; test/studio-wide.test.ts
 * holds that. The markup is LiveStudio's signed in branch, part for part.
 */
export function WideFixture({ name, cards = PICTURES_MADE.length }: { name: WideFixtureName; cards?: number }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<RegisterState>(() => opening(name));
  const [more, setMore] = useState({ hasMore: true, loadingMore: false });
  const timers = useRef<number[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const reduced = useIsReducedMotion();
  const top = useStickyTop(box);
  const folded = hasStarted(state);
  const { pressing, press } = useStudioPress(box, folded, reduced, true);

  useEffect(() => {
    let live = true;
    void fetch(PICTURE)
      .then((response) => response.blob())
      .then((blob) => {
        if (live) {
          setFile(new File([blob], "harbour-at-first-light.jpg", { type: blob.type || "image/jpeg" }));
        }
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);

  const path: Path = state.mode === "generate" ? "generate" : "upload";
  const shown: RegisterState = { ...state, file: state.mode === "upload" ? file : null };
  const studio = stubStudio(shown, () => setState((held) => ({ ...held, sealed: { ...held.sealed, saved: true } })));

  const play = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = RUN.map(({ state: pose, after }) =>
      window.setTimeout(() => setState((held) => keep(held, fixtureState(path, pose))), after),
    );
  };

  const reset = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    setState(fixtureState(path, "idle"));
  };

  const set = (patch: Partial<RegisterState>) => setState((held) => ({ ...held, ...patch }));
  const receipt = <Receipt studio={studio} />;
  const identity = (
    <IdentityStrip account={studio.account} wallet={CREATOR} sponsorship={studio.sponsorship} passkey onSignOut={NOTHING} />
  );

  const passports: CreatorPassports = {
    status: "ready",
    passports: cardsOf(cards),
    error: null,
    refresh: NOTHING,
    hasMore: more.hasMore,
    loadingMore: more.loadingMore,
    moreError: null,
    more: () => {
      setMore({ hasMore: true, loadingMore: true });
      timers.current.push(window.setTimeout(() => setMore({ hasMore: false, loadingMore: false }), 900));
    },
  };

  return (
    <WideLayout>
      <MotionConfig reducedMotion="user">
        <div data-wide-fixture={name}>
          <div className="lg:hidden">{identity}</div>

          <StudioBox hold={box} top={top} fill>
            <PathChoice
              mode={state.mode}
              busy={folded || isBusy(state)}
              running={folded}
              onMode={(mode) => setState((held) => keep(held, fixtureState(mode, "idle")))}
            />
            <div className={folded ? "" : "mt-6 lg:mt-0"}>
              {state.mode === "generate" ? (
                <GeneratePanel
                  state={shown}
                  wallet={CREATOR}
                  receipt={receipt}
                  pressing={pressing}
                  onPrompt={(prompt) => set({ prompt })}
                  onTitle={(title) => set({ title })}
                  onConsent={(consent) => set({ consent })}
                  onSealed={(on, privateRecheck) =>
                    setState((held) => ({ ...held, sealed: { ...held.sealed, on, privateRecheck: on && privateRecheck === true } }))
                  }
                  onIncludePrompt={(includePrompt) => setState((held) => ({ ...held, sealed: { ...held.sealed, includePrompt } }))}
                  onSaved={studio.actions.saveSealed}
                  onGenerate={() => press(play)}
                  onReset={reset}
                  onUnsponsored={NOTHING}
                  onBind={NOTHING}
                  onRecheck={NOTHING}
                />
              ) : (
                <RegisterPanel
                  state={shown}
                  wallet={CREATOR}
                  receipt={receipt}
                  pressing={pressing}
                  onChoose={setFile}
                  onTitle={(title) => set({ title })}
                  onConsent={(consent) => set({ consent })}
                  onSealed={(on, privateRecheck) =>
                    setState((held) => ({ ...held, sealed: { ...held.sealed, on, privateRecheck: on && privateRecheck === true } }))
                  }
                  onSaved={studio.actions.saveSealed}
                  onRegister={() => press(play)}
                  onReset={reset}
                  onUnsponsored={NOTHING}
                  onBind={NOTHING}
                  onRecheck={NOTHING}
                />
              )}
            </div>
          </StudioBox>

          <div className="mt-24 hidden lg:block">{identity}</div>
          <YourPassports passports={passports} />
        </div>
      </MotionConfig>
    </WideLayout>
  );
}

function opening(name: WideFixtureName): RegisterState {
  if (name === "done") {
    return fixtureState("upload", "donePublic");
  }
  return fixtureState(name, "idle");
}

/** A new pose, with the creator's own choices on the form carried into it. */
function keep(held: RegisterState, pose: RegisterState): RegisterState {
  return { ...pose, title: held.title, consent: held.consent };
}

/**
 * The bench's pictures as the index would list them, newest first, as many as
 * asked for. Past the bench's four they repeat with ids of their own, so a
 * short last row can be drawn at any count.
 */
export function cardsOf(count: number): CreatorPassport[] {
  return Array.from({ length: count }, (_, index) => {
    const picture = PICTURES_MADE[index % PICTURES_MADE.length];
    const round = Math.floor(index / PICTURES_MADE.length);
    return {
      id: (round === 0 ? picture.id : `${picture.id.slice(0, -2)}${String(round).padStart(2, "0")}`) as Hex,
      kind: picture.kind === "Agent drawing" ? 0 : 1,
      registeredAt: BigInt(Math.floor(REGISTERED_AT / 1000) - index * 172_800),
      registeredBlock: 103_059_393n - BigInt(index * 400_000),
      metadataURI: "ipfs://bafkreigmeta",
      title: picture.title,
      imageUrl: picture.image ?? undefined,
    };
  });
}

/** Just enough of the live hook's answer for the receipt and the strip to draw from. */
function stubStudio(register: RegisterState, onSaved: () => void): Studio {
  return {
    ready: true,
    authenticated: true,
    account: { kind: "email", value: "creator@moolam.test" },
    wallet: CREATOR,
    walletMissing: false,
    binding: { status: "bound", passkey: null, credentialId: undefined, error: null, refresh: NOTHING, remember: NOTHING },
    bind: initialBindState,
    confirming: false,
    register,
    sponsorship: "proven",
    balance: null,
    recovering: false,
    recovery: null,
    login: NOTHING,
    logout: NOTHING,
    actions: {
      bindThisDevice: NOTHING_LATER,
      recoverThisDevice: NOTHING_LATER,
      choose: NOTHING,
      setTitle: NOTHING,
      setPrompt: NOTHING,
      setMode: NOTHING,
      setConsent: NOTHING,
      setSealed: NOTHING,
      setIncludePrompt: NOTHING,
      saveSealed: onSaved,
      stateAgain: NOTHING_LATER,
      registerImage: NOTHING_LATER,
      generateImage: NOTHING_LATER,
      resend: NOTHING_LATER,
      recheck: NOTHING_LATER,
      clearBind: NOTHING,
      reset: NOTHING,
    },
    passports: EMPTY,
  };
}

const EMPTY: CreatorPassports = {
  status: "ready",
  passports: [],
  error: null,
  refresh: NOTHING,
  hasMore: false,
  loadingMore: false,
  moreError: null,
  more: NOTHING,
};
