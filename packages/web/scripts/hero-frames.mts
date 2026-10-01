/**
 * Makes the film's degrade ladder: the four still frames the reduced-motion page
 * shows under the shared beat (public/hero/frame-*.jpg) and every figure in
 * public/hero/degrade.json, from one registered picture.
 *
 * The frames are the verify service's own transforms() run on the registered
 * bytes, and every figure is that service's answer to POST /verify for each
 * transformed file, so the page shows the very files its numbers were measured
 * on. It needs the verify service running and pointed at the live index.
 *
 *   npx tsx packages/web/scripts/hero-frames.mts [passportId]
 *
 * The passport defaults to the film's first pick (components/story/data.ts).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transforms, type TransformName } from "../../verifier/src/transforms.js";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERO = path.join(WEB, "public", "hero");
const DEPLOYMENT = path.join(WEB, "..", "contracts", "deployments", "monad-mainnet.json");

/** The film's first pick, Monsoon Fishing Nets Drying. */
const FIRST_PICK = "0xcdb25d3755452efa3b746f168cf9cefd3a1b693ab2b81d260a2d64f13d771638";

/** The six steps the film plays, in order. */
const SHOWN: TransformName[] = ["rotate-90", "mirror", "reencode-q60", "reencode-q30", "social-chain", "resize-10"];

/** The steps the still page shows as files. Turning and flipping change no pixels, so those two are CSS. */
const FRAMES: TransformName[] = ["reencode-q60", "reencode-q30", "social-chain", "resize-10"];

function env(): Record<string, string> {
  const text = readFileSync(path.join(WEB, ".env.local"), "utf8");
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
}

interface Best {
  id: string;
  phashDistance: number;
  blockhashDistance: number;
  variant: string;
  score: number;
}

async function verify(verifier: string, bytes: Buffer): Promise<{ exact: string | null; best: Best | null }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "copy.jpg");
  const response = await fetch(`${verifier}/verify`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`the verify service answered ${response.status}`);
  }
  const answer = (await response.json()) as { result: { exact: string | null; best: Best | null } };
  return answer.result;
}

async function main(): Promise<void> {
  const settings = env();
  const passportId = (process.argv[2] ?? FIRST_PICK).toLowerCase();
  const verifier = (settings.NEXT_PUBLIC_VERIFIER_URL ?? "http://localhost:4010").replace(/\/+$/, "");
  const gateway = (settings.NEXT_PUBLIC_IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs/").replace(/\/?$/, "/");
  const deployment = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { registry: string; chainId: number };

  const indexed = (await (
    await fetch(settings.NEXT_PUBLIC_ENVIO_GRAPHQL_URL ?? "", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($id: String!) { Passport(where: { id: { _eq: $id } }) { metadataURI registeredAt } }`,
        variables: { id: passportId },
      }),
    })
  ).json()) as { data: { Passport: { metadataURI: string; registeredAt: string }[] } };
  const record = indexed.data.Passport[0];
  if (record === undefined) {
    throw new Error(`the index has no passport ${passportId}`);
  }
  const document = (await (await fetch(gateway + record.metadataURI.replace("ipfs://", ""))).json()) as { image: string };
  const imageCid = document.image.replace("ipfs://", "");
  const bytes = Buffer.from(await (await fetch(gateway + imageCid)).arrayBuffer());

  const original = await verify(verifier, bytes);
  if (original.exact?.toLowerCase() !== passportId) {
    throw new Error(`the registered bytes did not come back as ${passportId}`);
  }

  const copies = await transforms(bytes);
  const steps = [];
  for (const [name, copy] of Object.entries(copies) as [TransformName, Buffer][]) {
    const { best } = await verify(verifier, copy);
    const matched = best !== null && best.id.toLowerCase() === passportId;
    steps.push({
      transform: name,
      confidence: matched ? best.score : 0,
      matchedPassport: matched ? passportId : null,
      phashDistance: matched ? best.phashDistance : null,
      blockhashDistance: matched ? best.blockhashDistance : null,
      variant: matched ? best.variant : null,
      bytes: copy.length,
    });
  }
  for (const name of SHOWN) {
    if (steps.find((step) => step.transform === name)?.matchedPassport === null) {
      throw new Error(`${name} did not find its passport, so the film cannot show it`);
    }
  }

  const frames: Record<string, { file: string; bytes: number }> = {};
  for (const name of FRAMES) {
    const copy = copies[name];
    writeFileSync(path.join(HERO, `frame-${name}.jpg`), copy);
    frames[name] = { file: `/hero/frame-${name}.jpg`, bytes: copy.length };
  }

  const health = (await (await fetch(`${verifier}/health`)).json()) as { records?: number };
  const ladder = {
    measuredAt: new Date().toISOString(),
    verifier: { url: verifier, route: "POST /verify", records: health.records ?? null },
    registry: deployment.registry,
    chainId: deployment.chainId,
    passportId,
    imageCid,
    imageBytes: bytes.length,
    registeredAt: Number(record.registeredAt),
    note: "Every number here came from POST /verify on the running verifier, measured on the image at imageCid. shown lists the six steps the film plays, in order; steps holds all fifteen the verifier runs, including any that do not match at all.",
    original: { transform: "as-registered", confidence: 1, exact: passportId },
    shown: SHOWN,
    steps,
    frames,
    framesNote:
      "Produced by the verifier's own transforms() on the bytes at imageCid, so what the page shows is the file the numbers were measured on. rotate-90 and mirror are not here: turning and flipping change no pixels, so the page does those with a CSS transform on the same frame.",
  };
  writeFileSync(path.join(HERO, "degrade.json"), `${JSON.stringify(ladder, null, 2)}\n`);
  console.log(steps.map((step) => `${step.transform} ${step.phashDistance ?? "no match"}`).join("\n"));
}

await main();
