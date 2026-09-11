import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The pages live in docs/ at the top of the repo, outside this package, so the
 * app has to find the repo before it can read them. Walking up until nav.json
 * shows up works from the app, from a build and from a test run, whichever
 * directory the command was started in.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let up = 0; up < 6; up += 1) {
    if (existsSync(path.join(dir, "docs", "nav.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("docs/nav.json was not found above " + process.cwd());
}

export const repoRoot = findRepoRoot();

export const docsRoot = path.join(repoRoot, "docs");

/** The folders the docs pages are allowed to link a file out of. */
export const servableRoots = ["docs", "proofs"] as const;
