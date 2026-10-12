import { unstable_cache } from "next/cache";
import { askIndex } from "@/lib/data/passports";

const NEWEST = `query NewestRegistration {
  Passport(order_by: { registeredAt: desc }, limit: 1) {
    id
  }
}`;

/**
 * How long the newest id is held. The index allows about a hundred queries a
 * minute, shared by the live site, the verify service and every build, so the
 * board asks at most once every two minutes however many people open it, and a
 * new registration still reaches the next visitor within two minutes.
 */
const HOLD_SECONDS = 120;

const heldNewest = unstable_cache(
  async () => {
    const data = await askIndex<{ Passport: { id: string }[] }>(NEWEST, {});
    return data.Passport[0]?.id ?? "";
  },
  ["moolam-agents-newest"],
  { revalidate: HOLD_SECONDS },
);

/**
 * The id of the newest passport the index has seen, held for HOLD_SECONDS.
 *
 * The board's held reads are filed under it. Held for a minute alone, the first
 * visitor after a quiet spell was handed the roster from before it, which once
 * left Dreamloom's agent off the board while its own page counted 11 passports.
 * A registration now files them under a new name, so a visitor after it reads
 * the index afresh. Scores still move on the minute, since a check changes a
 * score without registering anything.
 *
 * An index that will not answer gives "", and the board falls back to the
 * minute's hold.
 */
export async function newestRegistration(): Promise<string> {
  try {
    return await heldNewest();
  } catch {
    return "";
  }
}
