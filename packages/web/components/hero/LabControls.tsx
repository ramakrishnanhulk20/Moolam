"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";

type Accent = "coral" | "amber";
type Motif = "seal" | "notch";

/**
 * The bench furniture: the accent and the motif are still open questions, so
 * both candidates sit behind a switch on this page and neither is written into a
 * component. Whichever Ram picks becomes the default in globals.css and this
 * whole file goes away.
 */
export function LabControls({ children }: { children: ReactNode }) {
  const [accent, setAccent] = useState<Accent>("coral");
  const [motif, setMotif] = useState<Motif>("seal");
  const { resolvedTheme, setTheme } = useTheme();
  const t = useTranslations("lab");

  return (
    <div data-accent={accent} data-motif={motif} style={{ ["--chrome" as string]: "8.5rem" }}>
      <div className="sticky top-[73px] z-30 border-b border-line bg-bg">
        <div className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3 sm:px-8 lg:px-14">
          <Group label={t("accent")}>
            <Choice active={accent === "coral"} onClick={() => setAccent("coral")}>
              {t("accentCoral")}
            </Choice>
            <Choice active={accent === "amber"} onClick={() => setAccent("amber")}>
              {t("accentAmber")}
            </Choice>
          </Group>

          <Group label={t("motif")}>
            <Choice active={motif === "seal"} onClick={() => setMotif("seal")}>
              <span className="motif h-[10px] w-[10px]" />
              {t("motifSeal")}
            </Choice>
            <Choice active={motif === "notch"} onClick={() => setMotif("notch")}>
              <span data-motif="notch">
                <span className="motif h-[10px] w-[10px]" />
              </span>
              {t("motifNotch")}
            </Choice>
          </Group>

          <Group label={t("theme")}>
            <Choice active={resolvedTheme !== "light"} onClick={() => setTheme("dark")}>
              {t("themeDark")}
            </Choice>
            <Choice active={resolvedTheme === "light"} onClick={() => setTheme("light")}>
              {t("themeLight")}
            </Choice>
          </Group>

          <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">
            {t("heading")}
          </span>
        </div>
      </div>

      {children}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-text-faint">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center gap-2 rounded-[8px] border border-line px-3 py-1.5 text-xs text-text-muted transition-colors duration-200 hover:border-line-strong hover:text-text aria-pressed:border-accent aria-pressed:text-accent"
    >
      {children}
    </button>
  );
}
