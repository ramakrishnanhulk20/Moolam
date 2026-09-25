"use client";

import { useTranslations } from "next-intl";
import type { Hex } from "viem";
import { WideLayout } from "@/components/studio/layout";
import { YourPassports } from "@/components/studio/YourPassports";
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
 */
export function OwnPictures({ wallet }: { wallet: Hex }) {
  const passports = useCreatorPassports(wallet);
  const grid = useTranslations("mine")("grid");

  return (
    <WideLayout>
      <YourPassports passports={passports} heading={grid} />
    </WideLayout>
  );
}
