"use server";

import { z } from "zod";
import { reason } from "@/lib/chain/client";
import { EXPLORE_PAGE, explorePassports, type PassportCursor } from "@/lib/data/passports";
import { buildPlates } from "./plates";
import { filterFor, EXPLORE_VIEWS, type ExploreView } from "./query";
import type { ExplorePlate } from "./sort";

/**
 * A server action is a public endpoint, so what arrives is checked here rather
 * than trusted because the button that calls it was written in this repo.
 */
const requestSchema = z.object({
  view: z.enum(EXPLORE_VIEWS as unknown as [ExploreView, ...ExploreView[]]),
  search: z.string().max(80),
  agent: z.string().regex(/^[0-9]{1,20}$/).nullable(),
  cursor: z
    .object({ registeredAt: z.string().regex(/^[0-9]{1,20}$/), id: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
    .nullable(),
});

export type MorePlates =
  | { ok: true; plates: ExplorePlate[]; cursor: PassportCursor | null }
  | { ok: false; error: string };

/**
 * The next page of the grid, for the "Load more" button.
 *
 * The filters travel from the URL, the cursor from the last row on screen, so
 * the reader keeps the page they are looking at and the address bar keeps
 * pointing at a view anyone else can open.
 */
export async function morePlates(input: unknown): Promise<MorePlates> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "that request did not name a page of the registry" };
  }

  const { view, search, agent, cursor } = parsed.data;

  try {
    const page = await explorePassports({
      filter: filterFor({ view, search, agent }),
      cursor,
      limit: EXPLORE_PAGE,
    });
    return { ok: true, plates: await buildPlates(page.passports), cursor: page.cursor };
  } catch (error) {
    return { ok: false, error: reason(error) };
  }
}
