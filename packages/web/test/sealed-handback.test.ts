import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkSealedFile, decodeBase64, sha256Of } from "@/lib/sealed/handback";
import { saveSealedFile } from "@/lib/sealed/save";
import type { SignedFile } from "@/lib/verifier/client";

/** A few hundred bytes that look like a jpeg's opening, which is all the check cares about. */
const PICTURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 300 }, (_, at) => (at * 7) % 251)]);

function hashOf(bytes: Uint8Array): `0x${string}` {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function handedBack(over: Partial<SignedFile> = {}): SignedFile {
  return {
    name: "kadal-at-dawn-1f2e3d4c.jpg",
    type: "image/jpeg",
    bytes: Buffer.from(PICTURE).toString("base64"),
    sha256: hashOf(PICTURE),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the check that has to pass before the passkey prompt", () => {
  it("agrees three ways and hands back a blob of the exact bytes under the service's name", async () => {
    const signedFile = handedBack();
    const check = await checkSealedFile({ signedFile, passportId: hashOf(PICTURE) });

    expect(check.ok).toBe(true);
    if (!check.ok) {
      return;
    }
    expect(check.file.name).toBe("kadal-at-dawn-1f2e3d4c.jpg");
    expect(check.file.type).toBe("image/jpeg");
    expect(check.file.size).toBe(PICTURE.length);
    expect(check.file.sha256).toBe(hashOf(PICTURE));
    expect(new Uint8Array(await check.file.blob.arrayBuffer())).toEqual(PICTURE);
  });

  it("stops on one tampered byte, whichever end of the answer was tampered with", async () => {
    const tampered = Uint8Array.from(PICTURE);
    tampered[17] ^= 0x01;

    // The bytes were changed on the way and the two hashes were not.
    const inTheBytes = await checkSealedFile({
      signedFile: handedBack({ bytes: Buffer.from(tampered).toString("base64") }),
      passportId: hashOf(PICTURE),
    });
    expect(inTheBytes).toEqual({ ok: false, problem: "hashMismatch" });

    // The bytes are the real ones and the id on the passport is somebody else's.
    const inTheId = await checkSealedFile({ signedFile: handedBack(), passportId: hashOf(tampered) });
    expect(inTheId).toEqual({ ok: false, problem: "hashMismatch" });

    // The bytes and the id agree and the field beside them does not, which
    // means the two ends are not describing the same file.
    const inTheField = await checkSealedFile({
      signedFile: handedBack({ sha256: hashOf(tampered) }),
      passportId: hashOf(PICTURE),
    });
    expect(inTheField).toEqual({ ok: false, problem: "hashMismatch" });
  });

  it("refuses an answer with nothing in it or base64 that will not decode", async () => {
    const empty = await checkSealedFile({ signedFile: handedBack({ bytes: "====" }), passportId: hashOf(PICTURE) });
    expect(empty).toEqual({ ok: false, problem: "undecodable" });

    const junk = await checkSealedFile({
      signedFile: handedBack({ bytes: "not base64 at all !!" }),
      passportId: hashOf(PICTURE),
    });
    expect(junk).toEqual({ ok: false, problem: "undecodable" });
  });

  it("reads base64 back byte for byte and hashes it the way the registry does", async () => {
    expect(decodeBase64(Buffer.from(PICTURE).toString("base64"))).toEqual(PICTURE);
    expect(await sha256Of(PICTURE)).toBe(hashOf(PICTURE));
  });
});

describe("saving the only copy", () => {
  /** A stand-in for the two things the save control touches: the URL store and one anchor. */
  function stubBrowser() {
    const anchor: Record<string, unknown> = { click: vi.fn(), remove: vi.fn() };
    const blobs: Blob[] = [];
    vi.stubGlobal("document", {
      createElement: () => anchor,
      body: { append: vi.fn() },
    });
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return `blob:moolam/${blobs.length}`;
      },
      revokeObjectURL: vi.fn(),
    });
    return { anchor, blobs };
  }

  it("downloads the blob under the name the service gave it", async () => {
    const { anchor, blobs } = stubBrowser();
    const check = await checkSealedFile({ signedFile: handedBack(), passportId: hashOf(PICTURE) });
    expect(check.ok).toBe(true);
    if (!check.ok) {
      return;
    }

    const url = saveSealedFile(check.file, null);

    expect(url).toBe("blob:moolam/1");
    expect(anchor.href).toBe("blob:moolam/1");
    expect(anchor.download).toBe("kadal-at-dawn-1f2e3d4c.jpg");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(blobs).toHaveLength(1);
    expect(new Uint8Array(await blobs[0].arrayBuffer())).toEqual(PICTURE);
  });

  it("makes one URL however many times the file is saved", async () => {
    const { blobs } = stubBrowser();
    const check = await checkSealedFile({ signedFile: handedBack(), passportId: hashOf(PICTURE) });
    if (!check.ok) {
      throw new Error("the fixture should pass the check");
    }

    const first = saveSealedFile(check.file, null);
    const second = saveSealedFile(check.file, first);

    expect(second).toBe(first);
    expect(blobs).toHaveLength(1);
  });
});
