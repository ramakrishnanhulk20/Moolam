"use client";

import { MotionConfig } from "framer-motion";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { useStudio, type Studio as StudioState } from "@/lib/studio/useStudio";
import { holdsUnsavedFile, isBusy, type Mode } from "@/lib/studio/flow";
import { useUnsavedFileWarning } from "@/lib/sealed/save";
import { warmAfterPress } from "./afterPress";
import { useWide } from "./layout";
import { FailureDetails } from "./FailureDetails";
import { EmptyReceipt } from "./ReceiptFrame";
import { SignedOut } from "./SignedOut";
import { NoAccount, Notice, StudioBox, StudioWaiting } from "./StudioFrame";
import { hasStarted, useStickyTop, useStudioPress } from "./press";

// Everything below is only ever drawn for someone who has signed in, so a
// visitor who reads the page and leaves never downloads any of it. The loaders
// are named once here so the warm-up and the render share one chunk each.
const loadIdentity = () => import("./IdentityStrip").then((module) => module.IdentityStrip);
const loadBind = () => import("./BindCard").then((module) => module.BindCard);
const loadRecover = () => import("./RecoverCard").then((module) => module.RecoverCard);
const loadPathChoice = () => import("./PathChoice").then((module) => module.PathChoice);
const loadGenerate = () => import("./GeneratePanel").then((module) => module.GeneratePanel);
const loadRegister = () => import("./RegisterPanel").then((module) => module.RegisterPanel);
const loadReceipt = () => import("./Receipt").then((module) => module.Receipt);
const loadPassports = () => import("./YourPassports").then((module) => module.YourPassports);

const IdentityStrip = dynamic(loadIdentity);
const BindCard = dynamic(loadBind);
const RecoverCard = dynamic(loadRecover);
const PathChoice = dynamic(loadPathChoice);
const GeneratePanel = dynamic(loadGenerate);
const RegisterPanel = dynamic(loadRegister);
// The empty stub stands in while the real one arrives, so the column never
// loses its height under the card.
const Receipt = dynamic(loadReceipt, { loading: () => <EmptyReceipt /> });
const YourPassports = dynamic(loadPassports);

/**
 * The reason's place while the passkey sentence is formatted. It is cut out
 * again with the colon before it, so the translated sentence stands alone in
 * every language and Monad's own English waits under Details.
 */
const REASON_SLOT = "\uE001";
const REASON_CUT = /\s*[:\uFF1A]?\s*\uE001/u;

/**
 * The studio with the wallet SDK above it: the hook, the sign in, and every
 * card a creator walks through. StudioScreen loads this file once Privy's
 * provider is mounted, and not before.
 */
export function LiveStudio({ initialMode }: { initialMode?: Mode }) {
  const t = useTranslations("studio");
  const studio = useStudio(initialMode);
  const [rebinding, setRebinding] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const reduced = useIsReducedMotion();
  const top = useStickyTop(box);
  const wide = useWide();

  // The press is answered on the button, then the form folds into the band and
  // the page brings the box's top under the bar, so the whole run is in view
  // without a scroll. The same move runs in reverse for Make another.
  const folded = hasStarted(studio.register);
  const { pressing, press } = useStudioPress(box, folded, reduced, wide);

  // The only copy of a sealed picture lives in this tab until it is saved.
  useUnsavedFileWarning(holdsUnsavedFile(studio.register));

  // Once someone has signed in, the cards they are about to walk through are
  // fetched together while the chain is asked about their passkey, which takes
  // longer than any of them does to arrive.
  useEffect(() => {
    if (studio.authenticated) {
      void Promise.all([
        loadIdentity(),
        loadBind(),
        loadRecover(),
        loadPathChoice(),
        loadGenerate(),
        loadRegister(),
        loadReceipt(),
        loadPassports(),
      ]);
    }
  }, [studio.authenticated]);

  // A stub with a stamp on it stays the real receipt after a sign out, so a
  // run that happened is never wiped from the page by the account leaving it.
  const [stamped, setStamped] = useState(false);
  if (studio.authenticated && !stamped) {
    setStamped(true);
  }
  const receipt = stamped || studio.authenticated ? <Receipt studio={studio} /> : <EmptyReceipt />;

  const run = (action: () => Promise<void>) =>
    press(() => {
      warmAfterPress();
      void action();
    });

  // The bind card is a detour, not a destination. It opens on a clean card, it
  // closes the moment the key is on chain or the creator backs out, and neither
  // leaves the register and generate panels behind a reload.
  const toBind = () => {
    studio.actions.clearBind();
    setRebinding(true);
  };
  const bindRoute = rebinding && studio.bind.stage !== "bound";

  // A bind that just landed keeps its card, Bound face and transaction link,
  // for a moment, and then through the passkey read that follows it, so the
  // success is seen where the press was and the card never collapses first.
  const justBound = useMoment(studio.bind.stage === "bound", BOUND_MOMENT_MS);
  const boundCard = studio.bind.stage === "bound" && (justBound || studio.binding.status === "reading");
  const bindCard = (holding?: string) => (
    <BindCard
      state={studio.bind}
      rebind={rebinding}
      wallet={studio.wallet}
      confirming={studio.confirming}
      holding={holding}
      onBind={() => {
        warmAfterPress();
        return studio.actions.bindThisDevice();
      }}
      onRecheck={studio.actions.recheck}
      onUnsponsored={() => void studio.actions.resend(true)}
      balance={studio.balance}
      onCancel={bindRoute ? () => setRebinding(false) : undefined}
    />
  );

  const identity =
    studio.authenticated && studio.wallet !== undefined ? (
      <IdentityStrip
        account={studio.account}
        wallet={studio.wallet}
        sponsorship={studio.sponsorship}
        passkey={studio.binding.status === "bound"}
        onSignOut={studio.logout}
      />
    ) : null;

  return (
    <MotionConfig reducedMotion="user">
      {identity === null ? null : wide ? <div className="lg:hidden">{identity}</div> : identity}

      <StudioBox hold={box} top={top} fill={onPanel(studio, bindRoute || boundCard)}>
        <>
          {!studio.ready ? (
            <StudioWaiting />
          ) : !studio.authenticated ? (
            <SignedOut onSignIn={studio.login} />
          ) : studio.walletMissing ? (
            <NoAccount onSignOut={studio.logout} />
          ) : studio.wallet === undefined ? (
            <StudioWaiting />
          ) : boundCard ? (
            bindCard(justBound ? undefined : t("passkey.reading"))
          ) : studio.binding.status === "reading" ? (
            <StudioWaiting text={t("passkey.reading")} />
          ) : studio.binding.status === "unreadable" ? (
            <div>
              <Notice text={t("passkey.unreadable", { reason: REASON_SLOT }).replace(REASON_CUT, "")} tone="failed" />
              {studio.binding.error ? <FailureDetails reason={studio.binding.error} className="ms-[24px] mt-2" /> : null}
              <button
                type="button"
                onClick={studio.binding.refresh}
                className="mt-5 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
              >
                {t("actions.again")}
              </button>
            </div>
          ) : studio.binding.status === "unbound" || bindRoute ? (
            bindCard()
          ) : studio.binding.status === "bound-elsewhere" ? (
            <RecoverCard
              busy={studio.recovering}
              failure={studio.recovery}
              onRecover={() => {
                warmAfterPress();
                return studio.actions.recoverThisDevice();
              }}
              onBindInstead={toBind}
            />
          ) : (
            <>
              {/* The wide layout keeps the laptop switch where it was through the run,
                  quiet, so nothing above the two columns moves when the form folds.
                  The phone's fork still steps aside, as it always has. */}
              {folded && !wide ? null : (
                <PathChoice
                  mode={studio.register.mode}
                  busy={folded || isBusy(studio.register)}
                  running={folded}
                  onMode={studio.actions.setMode}
                />
              )}

              <div className={folded ? "" : wide ? "mt-6 lg:mt-0" : "mt-6"}>
                {studio.register.mode === "generate" ? (
                  <GeneratePanel
                    state={studio.register}
                    wallet={studio.wallet}
                    receipt={receipt}
                    pressing={pressing}
                    onPrompt={studio.actions.setPrompt}
                    onTitle={studio.actions.setTitle}
                    onConsent={studio.actions.setConsent}
                    onSealed={studio.actions.setSealed}
                    onIncludePrompt={studio.actions.setIncludePrompt}
                    onSaved={studio.actions.saveSealed}
                    onGenerate={() => run(studio.actions.generateImage)}
                    onReset={studio.actions.reset}
                    onUnsponsored={() => void studio.actions.resend(true)}
                    onBind={toBind}
                    onRecheck={studio.actions.recheck}
                    onSignIn={studio.login}
                    balance={studio.balance}
                  />
                ) : (
                  <RegisterPanel
                    state={studio.register}
                    wallet={studio.wallet}
                    receipt={receipt}
                    pressing={pressing}
                    onChoose={studio.actions.choose}
                    onTitle={studio.actions.setTitle}
                    onConsent={studio.actions.setConsent}
                    onSealed={studio.actions.setSealed}
                    onSaved={studio.actions.saveSealed}
                    onRegister={() => run(studio.actions.registerImage)}
                    onReset={studio.actions.reset}
                    onUnsponsored={() => void studio.actions.resend(true)}
                    onBind={toBind}
                    onRecheck={studio.actions.recheck}
                    onSignIn={studio.login}
                    balance={studio.balance}
                  />
                )}
              </div>
            </>
          )}
        </>

        {/* The stub belongs to the panel when there is one, so it lands under
            the run rather than under the card above it. Every other state of
            this screen still gets it, in the same column, under its card. */}
        {onPanel(studio, bindRoute || boundCard) ? null : receipt}
      </StudioBox>

      {/* On a laptop the wide layout gives the first screen to the picture and
          the form, so who is signed in moves down to head their own passports. */}
      {identity !== null && wide ? <div className="mt-24 hidden lg:block">{identity}</div> : null}

      {studio.authenticated && studio.wallet !== undefined ? <YourPassports passports={studio.passports} /> : null}
    </MotionConfig>
  );
}

/** True when the register or generate panel is the card on screen, and holds the stub itself. */
function onPanel(studio: StudioState, onBindCard: boolean): boolean {
  return (
    studio.ready &&
    studio.authenticated &&
    !studio.walletMissing &&
    studio.wallet !== undefined &&
    studio.binding.status === "bound" &&
    !onBindCard
  );
}

/** Long enough to read "Bound" and see the link to the transaction beside it. */
const BOUND_MOMENT_MS = 2_400;

/** True for `ms` after `on` turns true, and never while it is false. */
function useMoment(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  const [was, setWas] = useState(on);
  if (was !== on) {
    setWas(on);
    setShown(on);
  }

  useEffect(() => {
    if (!shown) {
      return;
    }
    const timer = window.setTimeout(() => setShown(false), ms);
    return () => window.clearTimeout(timer);
  }, [shown, ms]);

  return on && shown;
}
