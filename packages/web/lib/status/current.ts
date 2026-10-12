import { unstable_cache } from "next/cache";
import { systemStatus, type SystemStatus } from "./read";

/**
 * The footer's line, held for ten minutes.
 *
 * Every page carries the footer, so without this the three reads would run on
 * every request and the line would be the slowest thing on a cached page. The
 * hold is also a ceiling on every page: Next builds a page again at the
 * shortest hold of any read inside it, so a shorter hold here would make the
 * footer set the pace for the whole site. unstable_cache is what does it, rather
 * than fetch options, because the chain head comes through viem and never
 * touches a fetch call this code can pass options to.
 */
const held = unstable_cache(async () => await systemStatus(), ["moolam-system-status"], { revalidate: 600 });

export async function currentStatus(): Promise<SystemStatus> {
  return await held();
}
