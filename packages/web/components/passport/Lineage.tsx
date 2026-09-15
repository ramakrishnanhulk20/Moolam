import { getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import { shortHex } from "@/lib/chain/client";
import { ZERO_ID } from "@/lib/chain/registry";
import { Link } from "@/lib/i18n/routing";

/**
 * Where this picture came from and what was made out of it.
 *
 * An edit registers as its own passport carrying its parent's id, so the chain
 * of edits is a real record rather than a claim in the metadata. The row is a
 * ladder because a reader is following one line, not scanning a table.
 *
 * `parentDisputed` is the one thing here the chain cannot say: a dispute lands
 * on the picture it named, so the link up is where a reader learns that this
 * edit came from something proven fake. It is false when no index could answer,
 * which is why the mark appears rather than a word saying the chain is clean.
 */
export async function Lineage({
  parentId,
  edits,
  parentDisputed = false,
}: {
  parentId: Hex;
  edits: Hex[];
  parentDisputed?: boolean;
}) {
  const t = await getTranslations("passport");
  const hasParent = parentId !== ZERO_ID;

  return (
    <section>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("children.heading")}</h2>

      {hasParent ? (
        <div className="mt-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("parent")}</p>
          <Link
            href={`/passport/${parentId}`}
            className={`group mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 border bg-bg-raised p-5 transition-colors duration-200 hover:border-accent ${
              parentDisputed ? "border-failed/50" : "border-line"
            }`}
          >
            <span aria-hidden className="motif h-[10px] w-[10px] opacity-60 transition-opacity group-hover:opacity-100" />
            <span className="break-all font-mono text-sm text-text-muted transition-colors duration-200 group-hover:text-accent">
              {shortHex(parentId, 12, 10)}
            </span>
            {/* At 375 px the id already fills the line, so the mark wraps under it and reads from
                the same edge. From 640 px it sits at the far end of the row. */}
            {parentDisputed ? (
              <span
                title={t("lineageDisputed")}
                className="shrink-0 rounded-[3px] border border-failed/60 px-2 py-1 font-mono text-[9px] uppercase leading-none tracking-[0.18em] text-failed sm:ms-auto"
              >
                {t("lineageDisputed")}
              </span>
            ) : null}
          </Link>
        </div>
      ) : null}

      <div className="mt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("children.edits")}</p>
        {edits.length === 0 ? (
          <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-text-muted">{t("children.empty")}</p>
        ) : (
          <ol className="mt-3 space-y-px">
            {edits.map((child, index) => (
              <li key={child}>
                <Link
                  href={`/passport/${child}`}
                  className="group flex items-center gap-5 border-s-2 border-line bg-bg-raised px-5 py-4 transition-colors duration-200 hover:border-accent"
                >
                  <span className="font-mono text-[11px] tabular-nums text-text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="break-all font-mono text-sm text-text-muted transition-colors duration-200 group-hover:text-accent">
                    {shortHex(child, 12, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}

        {/* Says what a reader is looking at: who may add an edit here, and what holds them to it. */}
        <p className="mt-6 max-w-[46ch] border-t border-line pt-5 text-xs leading-relaxed text-text-faint">
          {t("edit.lineageNote")}
        </p>
      </div>
    </section>
  );
}
