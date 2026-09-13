import { unstable_cache } from "next/cache";
import { systemStatus, type SystemStatus } from "./read";

/**
 * The footer's line, held for thirty seconds.
 *
 * Every page carries the footer, so without this the three reads would run on
 * every request and the line would be the slowest thing on a cached page. Thirty
 * seconds is short enough that a service going down shows up while someone is
 * still looking at the site. unstable_cache is what does it, rather than fetch
 * options, because the chain head comes through viem and never touches a fetch
 * call this code can pass options to.
 */
const held = unstable_cache(async () => await systemStatus(), ["moolam-system-status"], { revalidate: 30 });

export async function currentStatus(): Promise<SystemStatus> {
  return await held();
}
