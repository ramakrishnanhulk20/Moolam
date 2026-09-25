import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a test that draws a fixture for a person to look at saves it: the
 * folder FIXTURE_DIR names, or the system's temp folder. Never inside the repo.
 */
export function fixtureOut(name: string): string {
  const folder = process.env.FIXTURE_DIR?.trim();
  return join(folder === undefined || folder === "" ? tmpdir() : folder, name);
}
