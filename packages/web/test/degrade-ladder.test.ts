import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { degradeSteps, measurement } from "@/components/story/measurements";
import degrade from "@/public/hero/degrade.json";

/**
 * The film's degrade ladder is a copy of the figures in public/hero/degrade.json,
 * kept so no client chunk carries the whole file and the address of the verifier
 * it was measured against. The copy is only honest while it matches the file, so
 * every figure the film shows is held to it here.
 *
 * What this does NOT cover: the built chunks themselves. That is a grep of the
 * production build for the word localhost, run beside the build.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("the degrade ladder the film plays", () => {
  it("holds every step and frame to the measured file, field by field", () => {
    const steps = degradeSteps();
    expect(steps.map((step) => step.transform)).toEqual(degrade.shown);
    for (const step of steps) {
      const measured = degrade.steps.find((entry) => entry.transform === step.transform);
      const frame = (degrade.frames as Record<string, { file: string } | undefined>)[step.transform];
      expect(step, step.transform).toEqual({
        transform: measured?.transform,
        confidence: measured?.confidence,
        phashDistance: measured?.phashDistance,
        blockhashDistance: measured?.blockhashDistance,
        variant: measured?.variant,
        bytes: measured?.bytes,
        frame: frame?.file ?? null,
      });
    }
  });

  it("holds the passport, the picture and the day to the measured file", () => {
    expect(measurement.passportId).toBe(degrade.passportId);
    expect(measurement.imageCid).toBe(degrade.imageCid);
    expect(measurement.measuredAt).toBe(degrade.measuredAt);
    expect(measurement.registry).toBe(degrade.registry);
    expect(measurement.exactConfidence).toBe(degrade.original.confidence);
  });

  it("gives the client no address of the machine the figures were measured on", () => {
    expect(degrade.verifier.url).toContain("localhost");
    expect(JSON.stringify({ steps: degradeSteps(), measurement })).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it("is imported by no file of the app, so no chunk can carry the whole file", () => {
    const importing = ["app", "components", "lib"]
      .flatMap((folder) => sources(path.join(WEB, folder)))
      .filter((file) => /from\s+["'][^"']*degrade\.json["']|import\(\s*["'][^"']*degrade\.json["']/.test(readFileSync(file, "utf8")));
    expect(importing.map((file) => path.relative(WEB, file))).toEqual([]);
  });
});
