"use client";

import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { YourPassports } from "@/components/studio/YourPassports";
import { useCreatorPassports, type CreatorPassports } from "@/lib/studio/useCreatorPassports";

/**
 * One signed in account's pictures, read from the index by its address.
 *
 * Nothing here is remembered from a session: the grid is the index's answer to
 * "what has this address registered", which is why the same account shows the
 * same pictures on a laptop it has never opened Moolam on before.
 */
export function OwnPictures({ wallet }: { wallet: Hex }) {
  const passports = useCreatorPassports(wallet);
  const grid = useTranslations("mine")("grid");

  return (
    <>
      <YourPassports passports={passports} heading={grid} />
      <LoadMore passports={passports} />
    </>
  );
}

/**
 * The press that reads the next page of this account's pictures.
 *
 * It says it is working on its own face, and a page that would not come back
 * is reported on the same line, with the rows already read left where they are.
 * The words are the Explore grid's, because it is the same press over the same
 * index.
 */
function LoadMore({ passports }: { passports: CreatorPassports }) {
  const t = useTranslations("explore");

  if (passports.status !== "ready" || !passports.hasMore) {
    return null;
  }

  return (
    <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4">
      <button
        type="button"
        onClick={passports.more}
        disabled={passports.loadingMore}
        aria-busy={passports.loadingMore}
        className="rounded-[8px] border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-text transition-colors duration-200 hover:border-accent hover:text-accent disabled:cursor-wait disabled:text-text-faint"
      >
        {passports.loadingMore ? t("loading") : t("loadMore")}
      </button>
      {passports.moreError === null ? null : (
        <p role="alert" className="max-w-[54ch] text-sm leading-relaxed text-failed">
          {t("error", { reason: passports.moreError })}
        </p>
      )}
    </div>
  );
}
