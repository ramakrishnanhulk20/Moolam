import { pinnedBytes } from "@/lib/images";
import type { TrySample } from "@/lib/data/samples";

/**
 * One offered picture, fetched back out of the gateway as a file.
 *
 * This is the whole difference between pressing a plate and dropping a file:
 * the bytes come from IPFS instead of from a disk. Everything after it, the
 * upload, the fingerprinting, the search and the answer, is the same path, so
 * what a judge sees when they press a plate is a real verification and not a
 * stored answer.
 *
 * The walk across gateways is the shared one: a gateway that takes the
 * connection and never answers must not leave the page reading "checking".
 */
export async function fileFromSample(sample: TrySample, fetchBytes = pinnedBytes): Promise<File> {
  const blob = await fetchBytes(sample.url);
  const type = blob.type.startsWith("image/") ? blob.type : "image/jpeg";
  return new File([blob], sampleFileName(sample, type), { type });
}

/**
 * A name for the fetched file, since the card prints the name it was handed.
 * The title is used where there is one, so a reader sees the picture's own name
 * rather than a content id.
 */
function sampleFileName(sample: TrySample, type: string): string {
  const stem = (sample.title ?? sample.id.slice(0, 10)).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${stem === "" ? "sample" : stem}.${type.split("/")[1] ?? "jpg"}`;
}
