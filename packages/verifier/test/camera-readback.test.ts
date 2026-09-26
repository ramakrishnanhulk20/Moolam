// Covers a WO-186b follow-up on photos that arrive with a camera's own record: when the read back of
// the file signed with that record runs out of time, the fault is this service's, so preparing
// throws ReadBackFault (a FingerprintFault, which every studio route answers 503 service-fault)
// rather than dropping the camera's record for good. A record that truly fails its checks is still
// dropped: test/camera-record.test.ts item 5 drives that path, and it is run once more here.
// The slow read is a stubbed Reader.fromAsset that never answers for a file Moolam has signed, so
// each timeout test waits out the real five second limit. Does NOT cover a real slow C2PA read,
// and does not drive the routes: the 503 for a ReadBackFault is covered in signing-faults.test.ts.

import { describe, expect, it, vi } from "vitest";

/** True while a read back of a file Moolam signed should never answer. */
const slow = vi.hoisted(() => ({ on: false }));

vi.mock("@contentauth/c2pa-node", async (importOriginal) => {
  const real = await importOriginal<typeof import("@contentauth/c2pa-node")>();
  const fromAsset: typeof real.Reader.fromAsset = async (asset, settings) => {
    const bytes = (asset as { buffer?: Buffer }).buffer;
    if (slow.on && bytes !== undefined && bytes.includes(Buffer.from("moolam-studio", "utf8"))) {
      return await new Promise<never>(() => undefined);
    }
    return await real.Reader.fromAsset(asset, settings);
  };
  return { ...real, Reader: Object.assign(Object.create(real.Reader) as typeof real.Reader, { fromAsset }) };
});

const { READ_MANIFEST_TIMEOUT_MS, cameraRecordFault } = await import("../src/c2pa.js");
const { FingerprintFault } = await import("../src/fingerprint.js");
const { ReadBackFault, prepareOrFallback, prepareSealed } = await import("../src/prepare.js");
const { cameraPhoto } = await import("./cameraPhoto.js");
const { segment, withSegments } = await import("./jpegParts.js");

const SETTINGS = { title: "Harbour", claimGenerator: "moolam-studio/0.1.0", action: "c2pa.opened" as const };

describe("a camera record whose read back runs out of time", () => {
  it("makes cameraRecordFault throw FingerprintFault instead of naming a fault in the record", async () => {
    const kept = await prepareOrFallback(await cameraPhoto(161), SETTINGS);
    expect(kept.cameraRecord).toBe("kept");

    slow.on = true;
    try {
      const started = Date.now();
      await expect(cameraRecordFault(kept.bytes, [])).rejects.toBeInstanceOf(FingerprintFault);
      expect(Date.now() - started).toBeGreaterThanOrEqual(READ_MANIFEST_TIMEOUT_MS - 50);
    } finally {
      slow.on = false;
    }
  }, 30_000);

  it("fails the preparation with ReadBackFault, public and sealed, rather than dropping the record", async () => {
    const upload = await cameraPhoto(162);
    const dropped: string[] = [];
    const log = { warn: (_details: Record<string, unknown>, message: string) => dropped.push(message) };

    slow.on = true;
    try {
      await expect(prepareOrFallback(upload, { ...SETTINGS, log })).rejects.toBeInstanceOf(ReadBackFault);
      await expect(prepareSealed(upload, { ...SETTINGS, log })).rejects.toBeInstanceOf(ReadBackFault);
    } finally {
      slow.on = false;
    }
    expect(dropped).toEqual([]);
  }, 60_000);

  it("still drops a record that truly fails its checks, and signs the picture plain", async () => {
    const touched = withSegments(await cameraPhoto(163), [segment(0xfe, Buffer.from("touched after capture"))]);

    const prepared = await prepareOrFallback(touched, SETTINGS);

    expect(prepared.embedded).toBe(true);
    expect(prepared.cameraRecord).toBe("dropped");
  }, 60_000);
});
