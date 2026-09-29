"use client";

import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { WideLayout } from "@/components/studio/layout";
import { YourPassports } from "@/components/studio/YourPassports";
import { Link } from "@/lib/i18n/routing";
import type { AccountName } from "@/lib/studio/account";
import { useCreatorPassports } from "@/lib/studio/useCreatorPassports";

/**
 * One signed in account's pictures, read from the index by its address.
 *
 * Nothing here is remembered from a session: the grid is the index's answer to
 * "what has this address registered", which is why the same account shows the
 * same pictures on a laptop it has never opened Moolam on before.
 *
 * The grid is the studio's, drawn wide: four across on a wide laptop, a short
 * last row closed by one quiet cell rather than grey gaps, and its own Load
 * more under it. The page and the studio then show one grid, not two copies.
 *
 * The page's own title already heads it, so the grid is led by who is signed
 * in and the one control that changes that, instead of a second heading.
 */
export function OwnPictures({
  wallet,
  account,
  onSignOut,
}: {
  wallet: Hex;
  account: AccountName;
  onSignOut: () => void;
}) {
  const passports = useCreatorPassports(wallet);
  const t = useTranslations("mine");
  const studio = useTranslations("studio");
  const name = account.value ?? studio(`identity.kind${capitalise(account.kind)}`);

  const lead = (
    <div data-mine-account className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
      <p className="min-w-0 break-all text-sm text-text-muted">{t("signedInAs", { account: name })}</p>
      <button
        type="button"
        onClick={onSignOut}
        className="tap rounded-[8px] border border-line px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-faint transition-colors duration-200 hover:border-accent hover:text-accent"
      >
        {studio("signOut")}
      </button>
    </div>
  );

  const empty = (
    <Link
      href="/studio"
      data-mine-make-first
      className="mt-6 inline-block rounded-[8px] bg-accent px-7 py-4 text-sm font-semibold uppercase tracking-[0.14em] text-accent-ink transition-transform duration-200 hover:-translate-y-0.5"
    >
      {t("makeFirst")}
    </Link>
  );

  return (
    <WideLayout>
      <YourPassports passports={passports} heading={t("grid")} lead={lead} empty={empty} />
    </WideLayout>
  );
}

function capitalise(value: string): string {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
