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
 */
export async function Lineage({ parentId, edits }: { parentId: Hex; edits: Hex[] }) {
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
            className="group mt-2 flex items-center gap-4 border border-line bg-bg-raised p-5 transition-colors duration-200 hover:border-accent"
          >
            <span aria-hidden className="motif h-[10px] w-[10px] opacity-60 transition-opacity group-hover:opacity-100" />
            <span className="break-all font-mono text-sm text-text-muted transition-colors duration-200 group-hover:text-accent">
              {shortHex(parentId, 12, 10)}
            </span>
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
      </div>
    </section>
  );
}
