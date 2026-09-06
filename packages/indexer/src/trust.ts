/// How much of what a generator claims has held up when someone rechecked it,
/// as a whole number from 0 to 100.
///
///   score = round(100 * (matched + 1) / (matched + mismatched + 2 * disputesUpheld + 2))
///
/// The "+1" on top and "+2" underneath are Laplace smoothing: a plain hit rate
/// would put a generator with one lucky attestation at 100 and a generator with
/// one unlucky one at 0, which is not evidence of anything. Smoothing starts
/// everyone at 50 and moves the score only as the count of real rechecks grows,
/// so the number a judge or a buyer reads is earned rather than noisy.
///
/// An upheld dispute counts double against the generator. A dispute is a human
/// resolver agreeing that the record was wrong, which is a much stronger signal
/// than one verifier's perceptual hash missing by a few bits, so it should cost
/// more than a single mismatch.
export function trustScore(
  matched: number,
  mismatched: number,
  disputesUpheld: number,
): number {
  const denominator = matched + mismatched + 2 * disputesUpheld + 2;
  const score = Math.round((100 * (matched + 1)) / denominator);
  // Counts are only ever incremented, so the maths cannot leave 0 to 100 on its
  // own. The clamp is here so a corrupted row can never publish a score the
  // frontend's gauge cannot draw.
  return Math.min(100, Math.max(0, score));
}
