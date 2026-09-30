// Step 5 of Dreamloom's setup, once the verify service lists Dreamloom and Dreamloom is deployed: weave
// ten pictures and register each in platform mode under Dreamloom's own name, with the "no AI use"
// terms, so the gallery a judge opens is not empty.
//
//   npm run setup:seed --workspace packages/dreamloom
//
// Draws with OpenAI through lib/server/image-model.ts and registers through lib/server/kit.ts, with the
// settings in packages/dreamloom/.env.local. Costs about 0.053 to 0.066 MON and about one cent of
// OpenAI per picture. Runs once: a marker in the data folder refuses a second run, and it records
// every passport that landed and the failure it stopped at.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AiUseTerms, PlatformRegistration } from "@moolam/platform";
import type { Hex } from "viem";
import { env } from "../lib/server/env";
import { drawPicture } from "../lib/server/image-model";
import { kitReady, registerPicture } from "../lib/server/kit";
import { writeAtomic } from "../lib/server/store";
import { termsFor } from "../lib/server/terms";
import { chosenTitle } from "../lib/server/title";
import { Refusal, invokedDirectly, runCli } from "./cli";
import { dreamloomEnvFile } from "./env-file";

export interface SeedPicture {
  title: string;
  prompt: string;
}

/** Ten scenes with no lettering, logos or real people in them, so nothing drawn can pass for a brand or a person. */
export const SEED_PICTURES: readonly SeedPicture[] = [
  { title: "Marigold balloon", prompt: "A hot air balloon woven from marigold petals drifting over a turquoise lagoon at sunrise, soft mist on the water" },
  { title: "The turtle greenhouse", prompt: "A glass greenhouse full of ferns riding on the back of a giant sea turtle through a coral reef, sun rays falling through the water" },
  { title: "Teacup stairway", prompt: "A spiral staircase of stacked porcelain teacups climbing into a violet night sky filled with glowing paper lanterns" },
  { title: "Leaf fox", prompt: "A fox made entirely of autumn leaves leaping across a frozen lake under green and purple northern lights" },
  { title: "Golden canal", prompt: "A floating market of folded paper boats on a canal of liquid gold at dusk, warm lamps reflected in ripples" },
  { title: "Blossom planet", prompt: "A tiny planet covered in cherry blossom trees with a single round red door, drifting among soft pastel clouds" },
  { title: "Desert whale", prompt: "A blue whale gliding over pink sand dunes at noon, leaving a long trail of sparkling blue mist behind it" },
  { title: "Clockwork hummingbird", prompt: "A clockwork hummingbird of copper gears sipping from a crystal flower, macro detail, emerald and amber light" },
  { title: "Firefly roots", prompt: "The roots of an ancient banyan tree forming a winding cave lit by thousands of fireflies, deep green shadows" },
  { title: "Jellyfish express", prompt: "A train of glowing jellyfish carriages crossing a bridge of rainbow ice over a misty canyon at twilight" },
];

export const SEED_MARKER = "seed-marker.json";

export interface SeededPicture {
  title: string;
  passportId: Hex;
  registerTx: Hex;
  consentTx: Hex | null;
}

interface Marker {
  startedAt: string;
  seeded: SeededPicture[];
  stoppedAt?: { title: string; reason: string };
}

export interface SeedOptions {
  /** The folder the marker goes in: Dreamloom's data folder when run for real. */
  dataDir: string;
  pictures?: readonly SeedPicture[];
  /** Draws a picture from a prompt. Dreamloom's OpenAI call unless a test stands in for it. */
  draw?: (prompt: string) => Promise<{ bytes: Uint8Array }>;
  /** Registers in platform mode. Dreamloom's own kit wrapper unless a test stands in for it. */
  register?: (file: Uint8Array, title: string, terms: AiUseTerms) => Promise<PlatformRegistration>;
  /** Called as each passport lands, so a long run shows progress. */
  onSeeded?: (picture: SeededPicture, index: number, total: number) => void;
}

/** Why a failure stopped the run, from fields that hold no secret: the kit's code, or the error's name. */
function reasonOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { name, code } = error as { name?: unknown; code?: unknown };
    if (name === "MoolamPlatformError" && typeof code === "string") return code;
    if (typeof name === "string") return name;
  }
  return "unknown";
}

/**
 * Weaves and registers each picture in turn, one at a time, with the noAi terms, and returns what
 * landed. The marker is created before anything is spent, so a second run is refused even after a
 * crash; it is rewritten after every passport and at the failure that stops the run.
 *
 * Throws Refusal when the marker already exists, or when a title or prompt breaks the seed's rules;
 * rethrows the first draw or register failure after writing it to the marker.
 */
export async function seedGallery(options: SeedOptions): Promise<SeededPicture[]> {
  const pictures = options.pictures ?? SEED_PICTURES;
  for (const picture of pictures) {
    if (chosenTitle(picture.title) !== picture.title) throw new Refusal(`the title "${picture.title}" breaks the title rule`);
    if (/poster/i.test(picture.prompt)) throw new Refusal(`the prompt for "${picture.title}" names a poster`);
  }
  const draw = options.draw ?? drawPicture;
  const register = options.register ?? registerPicture;
  const terms = termsFor("noAi");

  mkdirSync(options.dataDir, { recursive: true });
  const markerPath = path.join(options.dataDir, SEED_MARKER);
  const marker: Marker = { startedAt: new Date().toISOString(), seeded: [] };
  try {
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Refusal(`the gallery was already seeded (${markerPath} exists); read it, and remove it only to seed again on purpose`);
    }
    throw error;
  }
  const save = (): void => writeAtomic(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  for (const [index, picture] of pictures.entries()) {
    try {
      const { bytes } = await draw(picture.prompt);
      const registered = await register(bytes, picture.title, terms);
      const seeded: SeededPicture = {
        title: picture.title,
        passportId: registered.passportId,
        registerTx: registered.registerTx,
        consentTx: registered.consentTx,
      };
      marker.seeded.push(seeded);
      save();
      options.onSeeded?.(seeded, index, pictures.length);
    } catch (error) {
      marker.stoppedAt = { title: picture.title, reason: reasonOf(error) };
      save();
      throw error;
    }
  }
  return marker.seeded;
}

async function main(): Promise<void> {
  const envFile = dreamloomEnvFile();
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const settings = env();
  if (!kitReady()) {
    throw new Refusal(
      "the kit is not configured: set MOOLAM_VERIFY_URL, MOOLAM_SITE_URL, MONAD_RPC_URL, DREAMLOOM_WALLET_KEY, DREAMLOOM_PASSKEY_KEY, DREAMLOOM_PASSKEY_RP_ID and DREAMLOOM_PLATFORM_KEY",
    );
  }
  if (settings.OPENAI_API_KEY === undefined) throw new Refusal("OPENAI_API_KEY is not set, so nothing can be drawn");
  const seeded = await seedGallery({
    dataDir: settings.dataDir,
    onSeeded: (picture, index, total) => {
      console.log(`${index + 1}/${total} "${picture.title}": passport ${picture.passportId}`);
      console.log(`  register ${picture.registerTx}, terms ${picture.consentTx ?? "none"}`);
    },
  });
  console.log(`Seeded ${seeded.length} pictures. The marker is ${path.join(settings.dataDir, SEED_MARKER)}.`);
}

if (invokedDirectly(import.meta.url)) runCli(main);
