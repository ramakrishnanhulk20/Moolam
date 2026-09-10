import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import en from "@/messages/en.json";
import { MAX_UPLOAD_BYTES, checkImage } from "@/lib/upload/checkImage";
import { chosenProblem } from "@/components/verify/answer";

// next-intl's navigation helpers reach for next/navigation, which only resolves
// inside the bundler. The link is the one thing the try panel uses from it.
vi.mock("@/lib/i18n/routing", () => ({
  Link: (props: { href: string; children?: unknown }) =>
    createElement("a", { href: props.href }, props.children as never),
}));

const { localRefusal } = await import("@/components/story/TryPanel");
const { copyRefusal, sentenceFor } = await import("@/components/passport/CheckCopy");

/** A file of a stated size without allocating the bytes, which a 21 MB case would. */
function sized(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/**
 * The message files are read off disk rather than imported one by one, so a
 * language added later is checked without anyone remembering to list it here.
 */
const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

function panelOf(file: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(`${MESSAGES}${file}`, "utf8")) as {
    passport: { check: Record<string, string> };
  };
  return messages.passport.check;
}

const tooBig = sized("holiday.jpg", "image/jpeg", 21 * 1024 * 1024);
const notAnImage = new File(["notes"], "notes.txt", { type: "text/plain" });

describe("the check every upload path runs first", () => {
  it("mirrors the service's own limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(checkImage(sized("holiday.jpg", "image/jpeg", MAX_UPLOAD_BYTES))).toBeNull();
  });

  it("refuses a 21 MB file and says how big it is", () => {
    expect(checkImage(tooBig)).toEqual({ code: "too-large", reason: "22.0 MB" });
  });

  it("refuses a file that is not an image and says what it was", () => {
    expect(checkImage(notAnImage)).toEqual({ code: "not-an-image", reason: "text/plain" });
  });

  it("takes a jpeg, a png and a webp", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(checkImage(new File(["x"], "picture", { type }))).toBeNull();
    }
  });

  it("reads the name when the browser hands over no type at all", () => {
    expect(checkImage(new File(["x"], "Screenshot.PNG", { type: "" }))).toBeNull();
    expect(checkImage(new File(["x"], "picture.webp", { type: "" }))).toBeNull();
    expect(checkImage(new File(["x"], "archive", { type: "" }))).toEqual({ code: "not-an-image", reason: "archive" });
  });
});

describe("what each page says about a file it refuses", () => {
  it("gives the story's try panel a line it already has in every language", () => {
    expect(localRefusal(tooBig)).toBe("tooLarge");
    expect(localRefusal(notAnImage)).toBe("notAnImage");
    expect(localRefusal(new File(["x"], "picture.jpg", { type: "image/jpeg" }))).toBeNull();
    expect(en.story.tryIt.tooLarge.length).toBeGreaterThan(0);
    expect(en.story.tryIt.notAnImage.length).toBeGreaterThan(0);
  });

  it("gives the verify page the same sentence the service would have sent", () => {
    expect(chosenProblem(tooBig)).toEqual({ key: "problem.tooLarge" });
    expect(chosenProblem(notAnImage)).toEqual({ key: "problem.notAnImage" });
    expect(chosenProblem(new File(["x"], "picture.png", { type: "image/png" }))).toBeNull();
    expect(en.verify.problem.tooLarge.length).toBeGreaterThan(0);
    expect(en.verify.problem.notAnImage.length).toBeGreaterThan(0);
  });

  it("gives the passport panel a sentence per code, not the file's type", () => {
    expect(copyRefusal(tooBig)).toEqual({ key: "tooLarge" });
    expect(copyRefusal(notAnImage)).toEqual({ key: "notAnImage" });
    expect(copyRefusal(new File(["x"], "picture.webp", { type: "image/webp" }))).toBeNull();
  });

  it("prints that sentence in prose, and keeps the general line for the verifier", () => {
    const panel = en.passport.check as Record<string, string>;

    expect(panel[sentenceFor(copyRefusal(notAnImage)!)]).toBe("That is not an image file. Drop a JPEG, PNG or WebP.");
    expect(panel[sentenceFor(copyRefusal(tooBig)!)]).toBe("That file is over the 20 MB limit. Send a smaller copy.");
    // A code raised by the service, which this panel has no advice for.
    expect(sentenceFor({ key: "problem.rateLimited", reason: "slow down" })).toBe("failed");
  });

  it("says both sentences in every language the site serves", () => {
    const files = readdirSync(MESSAGES).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(10);

    for (const file of files) {
      const panel = panelOf(file);
      expect(panel.tooLarge?.length ?? 0, file).toBeGreaterThan(0);
      expect(panel.notAnImage?.length ?? 0, file).toBeGreaterThan(0);
    }
  });

  it("never reaches the network to refuse a file", async () => {
    const fetching = vi.spyOn(globalThis, "fetch");
    localRefusal(tooBig);
    chosenProblem(notAnImage);
    copyRefusal(notAnImage);
    expect(fetching).not.toHaveBeenCalled();
    fetching.mockRestore();
  });
});
