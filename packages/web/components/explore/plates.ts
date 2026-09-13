import { readArt } from "@/components/passport/art";
import type { ExplorePassport } from "@/lib/data/passports";
import type { ExplorePlate } from "./sort";

/**
 * The index's rows with the picture each one points at.
 *
 * One gateway read per row, run together, and every read already fails soft:
 * a row whose metadata will not load keeps its id, its kind and its marks and
 * shows the seal on a dark plate instead of a broken image.
 *
 * Numbers cross to the browser as plain ones on purpose. A second since the
 * epoch and an agent id both fit, and a bigint cannot travel from a server
 * component to a client one at all.
 */
export async function buildPlates(rows: ExplorePassport[]): Promise<ExplorePlate[]> {
  return await Promise.all(
    rows.map(async (row) => {
      const art = row.metadataURI === "" ? null : await readArt(row.metadataURI);
      return {
        id: row.id,
        kind: row.kind,
        registeredAt: Number(row.registeredAt),
        title: art?.title ?? null,
        thumbnailUrl: art?.thumbnailUrl ?? null,
        manifest: row.manifest,
        rechecked: row.rechecked,
        chainlink: row.chainlink,
        disputed: row.disputed,
        agentId: row.generatorId,
      };
    }),
  );
}
