import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { embedManifest, readManifest } from "../src/c2pa.js";
import {
  BLOCKHASH_MATCH_THRESHOLD,
  PHASH_MATCH_THRESHOLD,
  fingerprint,
  hamming64,
  hammingHex,
} from "../src/fingerprint.js";
import { transforms, type TransformName } from "../src/transforms.js";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const assetDir = path.join(packageRoot, "test-assets");

const WIDTH = 1024;
const HEIGHT = 768;

function readVersion(name: string): string {
  const candidates = [
    () => require.resolve(`${name}/package.json`),
    () => path.join(packageRoot, "..", "..", "node_modules", name, "package.json"),
    () => path.join(packageRoot, "node_modules", name, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate(), "utf8")) as { version?: string };
      if (parsed.version !== undefined) {
        return parsed.version;
      }
    } catch {
      continue;
    }
  }
  return "unknown";
}

/**
 * Draws a test picture with a diagonal gradient, a bright disc, a dark bar and
 * a checker patch. Flat colour would give every block hash the same value and
 * make the whole measurement meaningless, so the image needs real structure.
 */
function drawTestImage(): Buffer {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3);
  const discX = 700;
  const discY = 250;
  const discRadius = 160;

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 3;
      let r = Math.round((x / WIDTH) * 200 + 20);
      let g = Math.round((y / HEIGHT) * 180 + 30);
      let b = Math.round(((x + y) / (WIDTH + HEIGHT)) * 220 + 15);

      const dx = x - discX;
      const dy = y - discY;
      if (dx * dx + dy * dy < discRadius * discRadius) {
        r = 245;
        g = 230;
        b = 90;
      }

      if (y > 560 && y < 650 && x > 120 && x < 880) {
        r = 18;
        g = 22;
        b = 30;
      }

      if (x > 120 && x < 420 && y > 120 && y < 420 && (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0) {
        r = 240;
        g = 240;
        b = 245;
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  }

  return pixels;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

async function main(): Promise<void> {
  console.log("Installed versions");
  for (const name of ["sharp", "sharp-phash", "imghash", "@contentauth/c2pa-node"]) {
    console.log(`  ${pad(name, 24)} ${readVersion(name)}`);
  }
  console.log("");

  await mkdir(assetDir, { recursive: true });
  const raw = drawTestImage();
  const base = sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } });
  const png = await base.clone().png().toBuffer();
  const jpg = await base.clone().jpeg({ quality: 90 }).toBuffer();
  await writeFile(path.join(assetDir, "original.png"), png);
  await writeFile(path.join(assetDir, "original.jpg"), jpg);

  const originalPrint = await fingerprint(jpg);
  console.log(
    `Source image: ${originalPrint.width}x${originalPrint.height} ${originalPrint.format}, ${jpg.length} bytes`,
  );
  console.log(`  sha256    ${originalPrint.sha256}`);
  console.log(`  phash     ${originalPrint.phash.toString(16).padStart(16, "0")}`);
  console.log(`  blockhash ${originalPrint.blockhash}`);
  console.log("");

  const signed = await embedManifest(jpg, {
    title: "moolam-spike.jpg",
    claimGenerator: "moolam-verifier-spike/0.1.0",
    action: "c2pa.created",
    softBinding: { phash: originalPrint.phash, blockhash: originalPrint.blockhash },
  });
  await writeFile(path.join(assetDir, "signed.jpg"), signed);

  // The verify service reads this file by default, so running the spike is also
  // what gives a fresh clone something to match against.
  const passports = [
    {
      id: originalPrint.sha256,
      phash: originalPrint.phash.toString(),
      blockhash: originalPrint.blockhash,
      creator: "0x0000000000000000000000000000000000000001",
      parentId: null,
      registeredAt: Math.floor(Date.now() / 1000),
      metadataURI: "ipfs://moolam-spike-placeholder",
    },
  ];
  await writeFile(path.join(assetDir, "passports.json"), `${JSON.stringify(passports, null, 2)}
`, "utf8");

  const signedManifest = await readManifest(signed);
  const manifestBytes = signed.length - jpg.length;
  console.log(`C2PA embed: ok, manifest bytes ${manifestBytes}`);
  console.log(
    `C2PA read back: present=${signedManifest.present} actions=[${(signedManifest.actions ?? []).join(", ")}]`,
  );
  console.log(`  soft binding    ${signedManifest.softBinding?.alg ?? "none"}`);
  console.log(
    `  binding matches ${
      signedManifest.softBinding?.phash === originalPrint.phash &&
      signedManifest.softBinding?.blockhash === originalPrint.blockhash
    }`,
  );
  console.log(`  title           ${signedManifest.title ?? "none"}`);
  console.log(`  claim generator ${signedManifest.claimGenerator ?? "none"}`);
  console.log(`  manifest hash   ${signedManifest.manifestHash ?? "none"}`);
  console.log(`  ingredients     ${signedManifest.ingredients ?? 0}`);

  const unsigned = await readManifest(jpg);
  console.log(`C2PA read of the unsigned source: present=${unsigned.present}`);
  console.log("");

  const signedPrint = await fingerprint(signed);
  console.log(
    `Signing moved the fingerprint by: phash ${hamming64(originalPrint.phash, signedPrint.phash)} of 64, ` +
      `blockhash ${hammingHex(originalPrint.blockhash, signedPrint.blockhash)} of 256`,
  );
  console.log("");

  const outputs = await transforms(signed);
  const names = Object.keys(outputs) as TransformName[];

  console.log("Transforms applied to the signed JPEG, compared against it");
  console.log(
    `${pad("transform", 18)}${pad("sha256 equal", 14)}${pad("phash dist", 12)}${pad("blockhash dist", 16)}${pad("phash match", 13)}${pad("blockhash match", 17)}c2pa manifest`,
  );
  console.log("-".repeat(103));

  for (const name of names) {
    const variant = outputs[name];
    await writeFile(path.join(assetDir, `${name}.jpg`), variant);
    const print = await fingerprint(variant);
    const phashDistance = hamming64(signedPrint.phash, print.phash);
    const blockhashDistance = hammingHex(signedPrint.blockhash, print.blockhash);
    const manifest = await readManifest(variant);

    console.log(
      pad(name, 18) +
        pad(print.sha256 === signedPrint.sha256 ? "yes" : "no", 14) +
        pad(`${phashDistance} of 64`, 12) +
        pad(`${blockhashDistance} of 256`, 16) +
        pad(phashDistance <= PHASH_MATCH_THRESHOLD ? "yes" : "no", 13) +
        pad(blockhashDistance <= BLOCKHASH_MATCH_THRESHOLD ? "yes" : "no", 17) +
        (manifest.present ? "survived" : "gone"),
    );
  }

  console.log("");
  console.log(
    `Thresholds in use: phash <= ${PHASH_MATCH_THRESHOLD} of 64, blockhash <= ${BLOCKHASH_MATCH_THRESHOLD} of 256`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
