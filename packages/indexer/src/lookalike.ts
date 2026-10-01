/// The widths of the two fingerprints. A distance above either cannot come from
/// an honest comparison, so a record carrying one is not believed.
export const PHASH_BITS = 64;
export const BLOCKHASH_BITS = 256;

export type Registered = {
  id: string;
  registeredAt: bigint;
};

export type LookalikeFacts = {
  /// The checked passport as this index holds it, undefined when it has none.
  passport: Registered | undefined;
  /// The id the record named as earlier, undefined for "none found".
  earlierId: string | undefined;
  /// The earlier passport as this index holds it, undefined when it has none.
  earlier: Registered | undefined;
  phashDistance: number;
  blockhashDistance: number;
};

/// Whether a look-alike record names real passports in the right order.
///
/// The receiver checks only that the two ids differ; it cannot read the registry.
/// So the index holds the rest: the checked passport exists here, both distances
/// fit their fingerprints, and an earlier passport, when one is named, exists
/// here, is a different passport, and was registered in a strictly earlier
/// second. Equal seconds are never "earlier", whichever block came first. A
/// "none found" record passes on the first two alone and is still never a match.
export function isValidLookalike(facts: LookalikeFacts): boolean {
  const { passport, earlierId, earlier, phashDistance, blockhashDistance } = facts;
  if (passport === undefined) {
    return false;
  }
  if (!fits(phashDistance, PHASH_BITS) || !fits(blockhashDistance, BLOCKHASH_BITS)) {
    return false;
  }
  if (earlierId === undefined) {
    return true;
  }
  return (
    earlier !== undefined &&
    earlier.id === earlierId &&
    earlier.id !== passport.id &&
    earlier.registeredAt < passport.registeredAt
  );
}

function fits(distance: number, bits: number): boolean {
  return Number.isInteger(distance) && distance >= 0 && distance <= bits;
}

/// The passport a stored record counts toward as a later look-alike, or
/// undefined when it counts toward nothing. Only a network record that passed the
/// checks and names an earlier passport counts. The caller passes only a
/// passport's newest row, so a replaced record never reaches here.
export function countedEarlier(row: {
  network: boolean;
  valid: boolean;
  earlier_id: string | undefined;
}): string | undefined {
  return row.network && row.valid ? row.earlier_id : undefined;
}
