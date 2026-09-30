import { MoolamPlatformError, signAsAgent, waitForCreator, waitForPassport, type CosignHandle } from "@moolam/platform";
import { logLine } from "./http";
import { kitReady, reopenCosign } from "./kit";
import { advancePicture, listPictures, readPicture } from "./store";

/**
 * Carries each co-sign from the open link to the passport: waits for the visitor to open Moolam's
 * page, signs as Dreamloom's agent, and waits for the registry to hold the passport, writing each
 * step to the picture's record. The handle is the visitor's key to the page, so it lives on the
 * volume and in memory and never in a log line (D5); the kit's errors never carry it either.
 */

/**
 * The link is open 30 minutes from the prepare and the signature window runs 30 more, so an hour
 * past openBy nothing can still land. Only used to stop waiting, never to say something landed.
 */
const LAST_CHANCE_SECONDS = 60 * 60;

/** A verify service that did not answer is asked again, a few times, before the co-sign is given up. */
const RETRY_MS = 10_000;
const MAX_RETRIES = 6;

const EXPIRED: readonly string[] = ["cosign-expired", "deadline-passed", "timed-out"];

const running = new Set<string>();
let resumed = false;

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function failureWord(error: unknown): string {
  if (!(error instanceof MoolamPlatformError)) return "cosign";
  if (EXPIRED.includes(error.code)) return "expired";
  if (error.code === "passport-taken") return "taken";
  return "cosign";
}

/**
 * One co-sign's loop. `source` is the handle startCosign returned in this process, or the stored
 * handle text of one a previous process started, which is reopened with resumeCosign first.
 */
async function follow(id: string, source: CosignHandle | string): Promise<void> {
  let handle = typeof source === "string" ? undefined : source;
  const fromStore = typeof source === "string";
  for (let attempt = 0; ; attempt += 1) {
    try {
      handle ??= await reopenCosign(source as string);
      const record = readPicture(id);
      if (record === null) return;
      if (record.state === "cosign-open") {
        const digest = await waitForCreator(handle);
        try {
          await signAsAgent(handle, digest);
        } catch (error) {
          // A process that stopped after posting the signature and before writing the record finds
          // the service refusing a second one. waitForPassport below reads the registry itself, so
          // carrying on can only end in a passport that is really there or in "expired".
          if (!(fromStore && error instanceof MoolamPlatformError && error.code === "service-refused")) throw error;
        }
        if (advancePicture(id, "cosign-signed") === null) return;
      } else if (record.state !== "cosign-signed") {
        return;
      }
      const passport = await waitForPassport(handle);
      advancePicture(id, "registered", { passportId: passport.passportId.toLowerCase() });
      return;
    } catch (error) {
      if (error instanceof MoolamPlatformError && error.code === "service-unreachable" && attempt < MAX_RETRIES) {
        await pause(RETRY_MS);
        continue;
      }
      advancePicture(id, "failed", { failure: failureWord(error) });
      logLine("cosign", error instanceof MoolamPlatformError ? error.code : "unexpected failure");
      return;
    }
  }
}

function start(id: string, source: CosignHandle | string): Promise<void> {
  if (running.has(id)) return Promise.resolve();
  running.add(id);
  return follow(id, source).finally(() => running.delete(id));
}

/** Follows a co-sign this process just opened, in the background. */
export function followCosign(id: string, handle: CosignHandle): void {
  void start(id, handle);
}

/**
 * Picks up every co-sign a previous process left open or signed, once per process, with resumeCosign. A record whose
 * last chance has passed on the clock is marked "expired" without asking anyone.
 *
 * Resolves when every picked-up co-sign has finished, which only tests wait for.
 */
export function resumeOpenCosigns(): Promise<void> {
  if (resumed) return Promise.resolve();
  resumed = true;
  // Without the kit nothing can be resumed, and failing the records would lose co-signs a
  // configured process could still finish.
  if (!kitReady()) return Promise.resolve();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const loops: Promise<void>[] = [];
  for (const record of listPictures()) {
    if ((record.state !== "cosign-open" && record.state !== "cosign-signed") || record.cosign === undefined) continue;
    if (nowSeconds > record.cosign.openBy + LAST_CHANCE_SECONDS) {
      advancePicture(record.id, "failed", { failure: "expired" });
      continue;
    }
    loops.push(start(record.id, record.cosign.handle));
  }
  return Promise.all(loops).then(() => undefined);
}
