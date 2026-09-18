import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi, type Abi } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));

// Three levels up from src/consent lands on packages/, where the contracts package publishes the
// ABIs it deploys. This is the published file rather than the Foundry build output, so this script
// runs on a fresh clone where out/ has never been built.
const ABI_FILE = join(HERE, "..", "..", "..", "contracts", "abi", "MoolamConsent.json");

let cached: Abi | undefined;

/** The ABI of the live MoolamConsent contract, read once from the contracts package. */
export function consentAbi(): Abi {
  if (cached) return cached;

  let raw: string;
  try {
    raw = readFileSync(ABI_FILE, "utf8");
  } catch {
    throw new Error(`No consent ABI at ${ABI_FILE}. It is published by packages/contracts.`);
  }

  const parsed = JSON.parse(raw) as Abi;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`The consent ABI at ${ABI_FILE} is not a non-empty ABI array.`);
  }
  cached = parsed;
  return parsed;
}

/** The one registry function this script asks: who holds a passport right now. */
export const registryHolderAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);
