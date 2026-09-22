"use client";

import { MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isPrivyConfigured } from "@/lib/env";
import { useIsReducedMotion } from "@/components/motion/useIsReducedMotion";
import { useWalletMounted } from "@/components/providers/WalletProvider";
import { useStudio, type Studio as StudioState } from "@/lib/studio/useStudio";
import { useHeadingLeading } from "./leading";
import { initialBindState } from "@/lib/studio/binding";
import { initialRegisterState, holdsUnsavedFile, isBusy, type Mode } from "@/lib/studio/flow";
import { useUnsavedFileWarning } from "@/lib/sealed/save";
import { BindCard } from "./BindCard";
import { GeneratePanel } from "./GeneratePanel";
import { IdentityStrip } from "./IdentityStrip";
import { PathChoice } from "./PathChoice";
import { Receipt } from "./Receipt";
import { RecoverCard } from "./RecoverCard";
import { RegisterPanel } from "./RegisterPanel";
import { SignedOut } from "./SignedOut";
import { WaitLabel } from "./WaitLabel";
import { hasStarted, useStickyTop, useStudioPress } from "./press";
import { YourPassports } from "./YourPassports";

/** A control that cannot do anything yet, on the page that is waiting for the wallet. */
const NOTHING = () => undefined;
const NOTHING_YET = async () => undefined;

/**
 * The studio as it stands before the wallet SDK is in the tree. Every field the
 * receipt reads is empty, which is what the hook itself answers until Privy is
 * up, so both paints come out the same.
 */
const WAITING: StudioState = {
  ready: false,
  authenticated: false,
  account: { kind: "account" },
  wallet: undefined,
  walletMissing: false,
  binding: { status: "reading", passkey: null, credentialId: undefined, error: null, refresh: NOTHING, remember: NOTHING },
  bind: initialBindState,
  confirming: false,
  register: initialRegisterState,
  sponsorship: "claimed",
  balance: null,
  recovering: false,
  recovery: null,
  login: NOTHING,
  logout: NOTHING,
  actions: {
    bindThisDevice: NOTHING_YET,
    recoverThisDevice: NOTHING_YET,
    choose: NOTHING,
    setTitle: NOTHING,
    setPrompt: NOTHING,
    setMode: NOTHING,
    setConsent: NOTHING,
    setSealed: NOTHING,
    setIncludePrompt: NOTHING,
    saveSealed: NOTHING,
    registerImage: NOTHING_YET,
    generateImage: NOTHING_YET,
    resend: NOTHING_YET,
    recheck: NOTHING_YET,
    stateAgain: NOTHING_YET,
    clearBind: NOTHING,
    reset: NOTHING,
  },
  passports: { status: "reading", passports: [], error: null, refresh: NOTHING },
};

/**
 * The studio, whole. Privy is optional at build time, so the hook that needs
 * its context only ever mounts under a configured app id and the page says
 * plainly what is missing otherwise.
 *
 * The hook is also held back until the SDK's provider is actually above this
 * screen. Called without it, Privy's own hooks warn into the console on every
 * render and answer ready false, so the page paints its waiting state from
 * here instead and mounts the hook once the wallet is really there.
 */
export function StudioScreen({ initialMode = initialRegisterState.mode }: { initialMode?: Mode }) {
  const mounted = useWalletMounted();

  if (!isPrivyConfigured) {
    return <Shell><NotConfigured /></Shell>;
  }

  return mounted ? <Studio initialMode={initialMode} /> : <Waiting />;
}

/** The page before the wallet arrives: the same frame and the same card the hook paints while it is not ready. */
function Waiting() {
  return (
    <MotionConfig reducedMotion="user">
      <Shell>
        <Box>
          <StudioWaiting />
          <Receipt studio={WAITING} />
        </Box>
      </Shell>
    </MotionConfig>
  );
}

/**
 * The same card a cold visitor is about to read, dimmed and inert until the
 * wallet lands.
 *
 * A one line wait label here instead measured 0.296 of layout shift on a
 * phone: the card dropped in at 889 px tall and shoved the receipt and the
 * footer off the screen. Same card, same height, nothing under it moves.
 */
function StudioWaiting() {
  const t = useTranslations("studio");

  return (
    <div className="relative" aria-busy="true">
      <div className="pointer-events-none select-none opacity-40">
        <SignedOut onSignIn={NOTHING} />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <WaitLabel text={t("opening")} />
      </div>
    </div>
  );
}

function Studio({ initialMode }: { initialMode: Mode }) {
  const t = useTranslations("studio");
  const studio = useStudio(initialMode);
  const [rebinding, setRebinding] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const reduced = useIsReducedMotion();
  const top = useStickyTop(box);

  // The press is answered on the button, then the form folds into the band and
  // the page brings the box's top under the bar, so the whole run is in view
  // without a scroll. The same move runs in reverse for Make another.
  const folded = hasStarted(studio.register);
  const { pressing, press } = useStudioPress(box, folded, reduced);

  // The only copy of a sealed picture lives in this tab until it is saved.
  useUnsavedFileWarning(holdsUnsavedFile(studio.register));

  // The bind card is a detour, not a destination. It opens on a clean card, it
  // closes the moment the key is on chain or the creator backs out, and neither
  // leaves the register and generate panels behind a reload.
  const toBind = () => {
    studio.actions.clearBind();
    setRebinding(true);
  };
  const bindRoute = rebinding && studio.bind.stage !== "bound";

  return (
    <MotionConfig reducedMotion="user">
      <Shell>
        {studio.authenticated && studio.wallet !== undefined ? (
          <IdentityStrip
            account={studio.account}
            wallet={studio.wallet}
            sponsorship={studio.sponsorship}
            passkey={studio.binding.status === "bound"}
            onSignOut={studio.logout}
          />
        ) : null}

        <Box hold={box} top={top}>
          <>
            {!studio.ready ? (
              <StudioWaiting />
            ) : !studio.authenticated ? (
              <SignedOut onSignIn={studio.login} />
            ) : studio.walletMissing ? (
              <Notice text={t("noWallet")} />
            ) : studio.binding.status === "reading" ? (
              <WaitLabel text={t("passkey.reading")} />
            ) : studio.binding.status === "unreadable" ? (
              <div>
                <Notice text={t("passkey.unreadable", { reason: studio.binding.error ?? "" })} tone="failed" />
                <button
                  type="button"
                  onClick={studio.binding.refresh}
                  className="mt-5 rounded-[8px] border border-line px-5 py-3 text-[11px] uppercase tracking-[0.18em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
                >
                  {t("actions.again")}
                </button>
              </div>
            ) : studio.binding.status === "unbound" || bindRoute ? (
              <BindCard
                state={studio.bind}
                rebind={rebinding}
                wallet={studio.wallet}
                confirming={studio.confirming}
                onBind={studio.actions.bindThisDevice}
                onRecheck={studio.actions.recheck}
                onUnsponsored={() => void studio.actions.resend(true)}
                onCancel={bindRoute ? () => setRebinding(false) : undefined}
              />
            ) : studio.binding.status === "bound-elsewhere" ? (
              <RecoverCard
                busy={studio.recovering}
                failure={studio.recovery}
                onRecover={studio.actions.recoverThisDevice}
                onBindInstead={toBind}
              />
            ) : (
              <>
                {folded ? null : (
                  <PathChoice
                    mode={studio.register.mode}
                    busy={isBusy(studio.register)}
                    onMode={studio.actions.setMode}
                  />
                )}

                <div className={folded ? "" : "mt-6"}>
                  {studio.register.mode === "generate" ? (
                    <GeneratePanel
                      state={studio.register}
                      wallet={studio.wallet}
                      receipt={<Receipt studio={studio} />}
                      pressing={pressing}
                      onPrompt={studio.actions.setPrompt}
                      onTitle={studio.actions.setTitle}
                      onConsent={studio.actions.setConsent}
                      onSealed={studio.actions.setSealed}
                      onIncludePrompt={studio.actions.setIncludePrompt}
                      onSaved={studio.actions.saveSealed}
                      onGenerate={() => press(() => void studio.actions.generateImage())}
                      onReset={studio.actions.reset}
                      onUnsponsored={() => void studio.actions.resend(true)}
                      onBind={toBind}
                      onRecheck={studio.actions.recheck}
                    />
                  ) : (
                    <RegisterPanel
                      state={studio.register}
                      wallet={studio.wallet}
                      receipt={<Receipt studio={studio} />}
                      pressing={pressing}
                      onChoose={studio.actions.choose}
                      onTitle={studio.actions.setTitle}
                      onConsent={studio.actions.setConsent}
                      onSealed={studio.actions.setSealed}
                      onSaved={studio.actions.saveSealed}
                      onRegister={() => press(() => void studio.actions.registerImage())}
                      onReset={studio.actions.reset}
                      onUnsponsored={() => void studio.actions.resend(true)}
                      onBind={toBind}
                      onRecheck={studio.actions.recheck}
                    />
                  )}
                </div>
              </>
            )}

            {(studio.register.failure?.next === "unsponsored" || studio.bind.failure?.next === "unsponsored") &&
            studio.balance !== null ? (
              <p className="mt-5 max-w-[54ch] font-mono text-xs leading-relaxed text-text-faint">
                {t("register.balance", { mon: (Number(studio.balance) / 1e18).toFixed(4) })}
              </p>
            ) : null}
          </>

          {/* The stub belongs to the panel when there is one, so it lands under
              the run rather than under the card above it. Every other state of
              this screen still gets it, in the same column, under its card. */}
          {onPanel(studio, bindRoute) ? null : <Receipt studio={studio} />}
        </Box>

        {studio.authenticated && studio.wallet !== undefined ? <YourPassports passports={studio.passports} /> : null}
      </Shell>
    </MotionConfig>
  );
}

/** True when the register or generate panel is the card on screen, and holds the stub itself. */
function onPanel(studio: StudioState, bindRoute: boolean): boolean {
  return (
    studio.ready &&
    studio.authenticated &&
    !studio.walletMissing &&
    studio.binding.status === "bound" &&
    !bindRoute
  );
}

/**
 * The one box the whole studio lives in.
 *
 * The panel and the stub used to be two columns at lg, which put the answer to a
 * press below the fold of a laptop screen and beside it on a phone. They are one
 * column at every width now, off centre under the title rather than stretched
 * across the page, so the press, the run and the receipt read downwards as one
 * thing.
 *
 * Scroll anchoring is off inside it: a press folds a long form away, and the
 * browser answers that by putting the scroll back where the folded content used
 * to hold it, which undoes the one scroll that brings the run into view. Proved
 * on the bench in WO-124b.
 */
function Box({
  children,
  hold,
  top,
}: {
  children: ReactNode;
  hold?: React.RefObject<HTMLDivElement | null>;
  top?: number | null;
}) {
  return (
    <div
      ref={hold}
      data-studio-box
      className="mt-14 w-full max-w-[48rem] [overflow-anchor:none]"
      style={top === null || top === undefined ? undefined : ({ "--studio-top": `${top}px` } as CSSProperties)}
    >
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const t = useTranslations("studio");
  const leading = useHeadingLeading("leading-[0.86]", "leading-[1.12]");

  return (
    <div className="mx-auto w-full max-w-[1400px] px-5 py-16 sm:px-8 sm:py-24">
      <header className="relative">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.28em] text-accent"
        >
          <span className="motif h-[10px] w-[10px]" />
          {t("kicker")}
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.06, ease: [0.16, 1, 0.3, 1] }}
          className={`mt-6 max-w-[14ch] font-display text-[clamp(2.6rem,8.5vw,6.5rem)] font-semibold uppercase tracking-[-0.035em] ${leading}`}
        >
          {t("title")}
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.14, ease: [0.16, 1, 0.3, 1] }}
          className="mt-7 max-w-[52ch] text-base leading-relaxed text-text-muted sm:text-lg"
        >
          {t("lede")}
        </motion.p>

        <span
          aria-hidden
          className="pointer-events-none absolute right-0 top-2 hidden select-none font-mono text-[11px] uppercase tracking-[0.4em] text-text-faint lg:block"
          style={{ writingMode: "vertical-rl" }}
        >
          {t("rail")}
        </span>
      </header>

      <div className="mt-14">{children}</div>
    </div>
  );
}

function Notice({ text, tone = "muted" }: { text: string; tone?: "muted" | "failed" }) {
  return (
    <p className={`max-w-[54ch] text-sm leading-relaxed ${tone === "failed" ? "text-failed" : "text-text-muted"}`}>
      {text}
    </p>
  );
}

function NotConfigured() {
  const t = useTranslations("studio");
  return <Notice text={t("notConfigured")} tone="failed" />;
}
