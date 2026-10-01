"use client";

import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { WaitLabel } from "@/components/studio/WaitLabel";
import type { ClaimsAnswer } from "@/lib/claims/client";
import type { ClaimRefusal } from "@/lib/claims/refusal";
import { failureKey, type PlatformBusy } from "@/lib/claims/useClaims";
import { RefusalLine } from "./RefusalLine";

/**
 * The two standing choices a person keeps per platform, each with the one
 * action that undoes it: a platform sending future pictures straight to their
 * wallet, and a platform they said no to (P26). A choice that moves pictures
 * without a press is always on this page where the person can see and clear it.
 */
export function ClaimSettings({
  standing,
  muted,
  busy,
  failures,
  onStop,
  onUnmute,
  onReload,
  onSignIn,
}: {
  standing: ClaimsAnswer["standing"];
  muted: ClaimsAnswer["muted"];
  busy: Readonly<Record<string, PlatformBusy>>;
  failures: Readonly<Record<string, ClaimRefusal>>;
  onStop: (key: Hex) => void;
  onUnmute: (key: Hex) => void;
  onReload: () => void;
  onSignIn: () => void;
}) {
  const t = useTranslations("claims");
  const rows = [
    ...standing.map((row) => ({ kind: "standing" as const, platform: row.platform })),
    ...muted.map((row) => ({ kind: "muted" as const, platform: row.platform })),
  ];

  if (rows.length === 0) {
    return null;
  }

  return (
    <div data-claims-settings>
      <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-text-faint">
        <span aria-hidden className="h-px w-6 bg-line-strong" />
        {t("settings.heading")}
      </p>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {rows.map((row, index) => {
          const key = row.platform.keyHash;
          const working = busy[key] === "stop" || busy[key] === "unmute";
          const failure = failures[failureKey("setting", key)];
          return (
            <motion.li
              key={`${row.kind}-${key}`}
              data-claims-setting={row.kind}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: Math.min(index, 6) * 0.05, ease: [0.16, 1, 0.3, 1] }}
              className="py-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <p className="flex min-w-0 items-start gap-2.5 text-base leading-snug text-text">
                  <span
                    aria-hidden
                    className={`motif mt-[6px] h-[7px] w-[7px] shrink-0 ${row.kind === "standing" ? "bg-accent" : "bg-text-faint"}`}
                  />
                  <span className="min-w-0 break-words">
                    {row.kind === "standing"
                      ? t("settings.standing", { platform: row.platform.name })
                      : t("settings.muted", { platform: row.platform.name })}
                  </span>
                </p>
                {working ? (
                  <WaitLabel text={t("saving")} />
                ) : (
                  <button
                    type="button"
                    disabled={busy[key] !== undefined}
                    onClick={() => (row.kind === "standing" ? onStop(key) : onUnmute(key))}
                    className="tap shrink-0 rounded-[8px] border border-line-strong px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    {row.kind === "standing" ? t("settings.stop") : t("settings.allow")}
                  </button>
                )}
              </div>
              {failure === undefined ? null : (
                <RefusalLine refusal={failure} className="mt-3" onReload={onReload} onSignIn={onSignIn} />
              )}
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
