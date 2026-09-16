"use client";

import { MotionConfig, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { isPrivyConfigured } from "@/lib/env";
import { useStudio } from "@/lib/studio/useStudio";
import { useHeadingLeading } from "./leading";
import { isBusy } from "@/lib/studio/flow";
import { BindCard } from "./BindCard";
import { GeneratePanel } from "./GeneratePanel";
import { IdentityStrip } from "./IdentityStrip";
import { PathChoice } from "./PathChoice";
import { Receipt } from "./Receipt";
import { RecoverCard } from "./RecoverCard";
import { RegisterPanel } from "./RegisterPanel";
import { SignedOut } from "./SignedOut";
import { WaitLabel } from "./WaitLabel";
import { YourPassports } from "./YourPassports";

/**
 * The studio, whole. Privy is optional at build time, so the hook that needs
 * its context only ever mounts under a configured app id and the page says
 * plainly what is missing otherwise.
 */
export function StudioScreen() {
  return isPrivyConfigured ? <Studio /> : <Shell><NotConfigured /></Shell>;
}

function Studio() {
  const t = useTranslations("studio");
  const studio = useStudio();
  const [rebinding, setRebinding] = useState(false);

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

        <div className="mt-14 grid gap-14 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-0">
          <div className="lg:pe-14">
            {!studio.ready ? (
              <WaitLabel text={t("opening")} />
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
                <PathChoice
                  mode={studio.register.mode}
                  busy={isBusy(studio.register)}
                  onMode={studio.actions.setMode}
                />

                <div className="mt-6">
                  {studio.register.mode === "generate" ? (
                    <GeneratePanel
                      state={studio.register}
                      wallet={studio.wallet}
                      onPrompt={studio.actions.setPrompt}
                      onTitle={studio.actions.setTitle}
                      onGenerate={studio.actions.generateImage}
                      onReset={studio.actions.reset}
                      onUnsponsored={() => void studio.actions.resend(true)}
                      onBind={toBind}
                      onRecheck={studio.actions.recheck}
                    />
                  ) : (
                    <RegisterPanel
                      state={studio.register}
                      wallet={studio.wallet}
                      onChoose={studio.actions.choose}
                      onTitle={studio.actions.setTitle}
                      onRegister={studio.actions.registerImage}
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
          </div>

          <Receipt studio={studio} />
        </div>

        {studio.authenticated && studio.wallet !== undefined ? <YourPassports passports={studio.passports} /> : null}
      </Shell>
    </MotionConfig>
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
