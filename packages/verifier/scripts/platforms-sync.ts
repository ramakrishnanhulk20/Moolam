// Writes the web app's copy of src/platforms. The web app cannot import from
// this package on Vercel, and this package's Docker image carries nothing but
// its own folder, so the list and its code live here and the web app holds a
// byte for byte copy that its platforms-copy test holds to this one.
//
//   npm run platforms:sync --workspace packages/verifier

import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = path.resolve(here, "..", "src", "platforms");
export const WEB_COPY_DIR = path.resolve(here, "..", "..", "web", "lib", "platforms");

/** Copies every file across and removes any the source no longer has. Returns the file names copied. */
export function syncPlatforms(): string[] {
  const files = readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  mkdirSync(WEB_COPY_DIR, { recursive: true });
  for (const name of readdirSync(WEB_COPY_DIR)) {
    if (!files.includes(name)) rmSync(path.join(WEB_COPY_DIR, name), { recursive: true });
  }
  for (const name of files) copyFileSync(path.join(SOURCE_DIR, name), path.join(WEB_COPY_DIR, name));
  return files;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = syncPlatforms();
  console.log(`Copied ${files.join(", ")} to ${WEB_COPY_DIR}`);
}
