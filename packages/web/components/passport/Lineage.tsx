import { getTranslations } from "next-intl/server";
import type { Hex } from "viem";
import { shortHex } from "@/lib/chain/client";
import { ZERO_ID } from "@/lib/chain/registry";
import { Link } from "@/lib/i18n/routing";
import { pictureSources } from "@/lib/images";
import type { Family, FamilyMember } from "./family";
import { Picture } from "./Picture";

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
 *
 * `family` names the relatives and carries their small pictures. A relative it
 * does not hold is drawn by its short id, which is what the page had before.
 */
export async function Lineage({
  parentId,
  edits,
  parentDisputed = false,
  family = {},
}: {
  parentId: Hex;
  edits: Hex[];
  parentDisputed?: boolean;
  family?: Family;
}) {
  const t = await getTranslations("passport");
  const untitled = t("untitled");
  const hasParent = parentId !== ZERO_ID;

  return (
    <section>
      <h2 className="font-mono text-[11px] uppercase tracking-[0.28em] text-text-faint">{t("children.heading")}</h2>

      {hasParent ? (
        <div className="mt-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-faint">{t("parent")}</p>
          <Link
            href={`/passport/${parentId}`}
            className={`group mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 border bg-bg-raised p-4 transition-colors duration-200 hover:border-accent sm:p-5 ${
              parentDisputed ? "border-failed/50" : "border-line"
            }`}
          >
            <Relative id={parentId} member={family[parentId.toLowerCase()]} untitled={untitled} />
            {/* At 375 px the name already fills the line, so the mark wraps under it and reads from
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
          <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-muted">{t("children.empty")}</p>
        ) : (
          <ol className="mt-3 space-y-px">
            {edits.map((child, index) => (
              <li key={child}>
                <Link
                  href={`/passport/${child}`}
                  className="group flex items-center gap-5 border-s-2 border-line bg-bg-raised px-5 py-3 transition-colors duration-200 hover:border-accent"
                >
                  <span className="font-mono text-[11px] tabular-nums text-text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <Relative id={child} member={family[child.toLowerCase()]} untitled={untitled} />
                </Link>
              </li>
            ))}
          </ol>
        )}

        {/* Says what a reader is looking at: who may add an edit here, and what holds them to it. */}
        <p className="mt-6 max-w-[54ch] border-t border-line pt-5 text-base leading-relaxed text-text-faint">
          {t("edit.lineageNote")}
        </p>
      </div>
    </section>
  );
}

/**
 * One relative: its small picture, its title, and its short id as a quiet
 * detail. A relative whose record could not be read keeps the id as its name,
 * and one with no picture to show, sealed or unreachable, gets the seal.
 */
function Relative({ id, member, untitled }: { id: Hex; member: FamilyMember | undefined; untitled: string }) {
  const seal = <span aria-hidden className="motif absolute inset-0 m-auto h-3 w-3 opacity-60" />;

  return (
    <span className="flex min-w-0 flex-1 items-center gap-4">
      <span className="grain relative h-12 w-12 shrink-0 overflow-hidden border border-line bg-bg-sunken">
        {member?.thumbnailUrl === undefined ? (
          seal
        ) : (
          <Picture
            sources={pictureSources(member.thumbnailUrl)}
            alt=""
            sizes="48px"
            quality={60}
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            fallback={seal}
          />
        )}
      </span>
      {member === undefined ? (
        <span className="min-w-0 break-all font-mono text-sm text-text-muted transition-colors duration-200 group-hover:text-accent">
          {shortHex(id, 12, 10)}
        </span>
      ) : (
        <span className="flex min-w-0 flex-col gap-1">
          <span
            data-relative-title
            className="truncate font-display text-base font-semibold leading-tight tracking-[-0.01em] text-text transition-colors duration-200 group-hover:text-accent"
          >
            {member.title ?? untitled}
          </span>
          <span className="font-mono text-[10px] tracking-[0.12em] text-text-faint">{shortHex(id, 6, 4)}</span>
        </span>
      )}
    </span>
  );
}
