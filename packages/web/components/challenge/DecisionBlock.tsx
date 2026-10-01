import { useFormatter, useTranslations } from "next-intl";
import type { DecisionView } from "@/lib/disputes/decisions";

/**
 * The verdict under the two sides of a challenge: which way Moolam went, when,
 * and the reasons it published. Anchored at #decision, so a mark elsewhere can
 * send a reader straight here.
 *
 * The reasons address is a link only when it is ipfs://<cid>; anything else is
 * printed as text and never followed (L28, L29). A decision with no published
 * reasons says so, rather than leaving a reader to wonder.
 */
export function DecisionBlock({ view }: { view: DecisionView }) {
  const t = useTranslations("challenge.decision");
  const format = useFormatter();
  const upheld = view.outcome === "upheld";
  const date = view.date === null ? null : format.dateTime(new Date(view.date * 1000), { dateStyle: "medium" });

  return (
    <div id="decision" data-decision={view.outcome} className="rise mt-8 scroll-mt-28 border-t border-line pt-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("heading")}</p>
      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] lg:items-end lg:gap-12">
        <p
          className={`flex items-start gap-4 font-display text-[clamp(1.3rem,2.6vw,2.1rem)] font-semibold leading-[1.04] tracking-[-0.03em] ${
            upheld ? "text-disputed" : "text-text"
          }`}
        >
          <span aria-hidden className={`motif mt-[0.4em] h-3 w-3 shrink-0 ${upheld ? "bg-disputed" : "bg-text-muted"}`} />
          <span className="min-w-0">
            {date === null ? t(`${view.outcome}Undated`) : t(view.outcome, { date })}
          </span>
        </p>

        <div className="min-w-0 lg:border-s lg:border-line lg:ps-10">
          {view.reasons.kind === "link" ? (
            <a
              href={view.reasons.href}
              target="_blank"
              rel="noreferrer"
              data-reasons-link
              className="group inline-flex items-center gap-3 rounded-[8px] border border-line px-5 py-3 text-xs uppercase tracking-[0.16em] text-text-muted transition-colors duration-200 hover:border-accent hover:text-accent"
            >
              {t("reasons")}
              <span aria-hidden className="h-px w-5 bg-current transition-all duration-300 group-hover:w-8" />
            </a>
          ) : view.reasons.kind === "text" ? (
            <p data-reasons-text className="break-all font-mono text-[11px] leading-relaxed text-text-faint">
              {view.reasons.uri}
            </p>
          ) : (
            <p data-reasons={view.reasons.kind} className="max-w-[40ch] text-base leading-relaxed text-text-faint">
              {view.reasons.kind === "none" ? t("noReasons") : t("unread")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
