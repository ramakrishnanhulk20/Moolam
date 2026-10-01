import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeEditFailure } from "@/lib/passport/edit";
import { describeFailure } from "@/lib/studio/problems";
import { VerifierError } from "@/lib/verifier/client";

const MESSAGES = fileURLToPath(new URL("../messages/", import.meta.url));

/**
 * A refusal about the picture itself reads as that reason, in the reader's language.
 *
 * The client names the family from the status alone, so a 422 is "bad-response" and every 413 is
 * "too-large". Left there, a picture whose fingerprint would not survive copying read as an answer
 * this app did not understand, and a file that only grew past 20 MB when the passport was signed
 * into it read "that file is over the 20 MB limit", which was untrue for the file the person chose.
 */

function refused(code: "bad-response" | "too-large", status: number, word: string): VerifierError {
  return new VerifierError(code, status, "the service's English", undefined, { serviceCode: word, named: true });
}

describe("an edit refused for the picture itself", () => {
  it("reads a 422 fingerprint-unstable as its own sentence, not as an answer it did not understand", () => {
    expect(describeEditFailure(refused("bad-response", 422, "fingerprint-unstable"))).toEqual({
      key: "fingerprintUnstable",
    });
  });

  it("reads a 413 signed-file-too-large as the signature pushing it over, not as a file already over", () => {
    expect(describeEditFailure(refused("too-large", 413, "signed-file-too-large"))).toEqual({
      key: "signedFileTooLarge",
    });
  });

  it("reads a 422 thumbnail-too-large as its own sentence", () => {
    expect(describeEditFailure(refused("bad-response", 422, "thumbnail-too-large"))).toEqual({
      key: "thumbnailTooLarge",
    });
  });

  it("offers no retry for any of the three, because the same file would be refused again", () => {
    for (const [code, status, word] of [
      ["bad-response", 422, "fingerprint-unstable"],
      ["too-large", 413, "signed-file-too-large"],
      ["bad-response", 422, "thumbnail-too-large"],
    ] as const) {
      expect(describeEditFailure(refused(code, status, word)).next, word).toBeUndefined();
    }
  });

  it("still reads an upload that was over 20 MB when it arrived as the plain size limit", () => {
    const over = new VerifierError("too-large", 413, "the image is larger than the 20971520 byte limit", undefined, {
      serviceCode: "the image is larger than the 20971520 byte limit",
      named: true,
    });
    expect(describeEditFailure(over).key).toBe("tooLarge");
  });
});

describe("a studio upload refused for the picture itself", () => {
  it("reads a 413 signed-file-too-large from /prepare as the signature pushing it over", () => {
    expect(describeFailure(refused("too-large", 413, "signed-file-too-large"), "prepare")).toEqual({
      key: "signedFileTooLarge",
    });
  });

  it("still reads an upload that was over 20 MB when it arrived as the plain size limit", () => {
    const over = new VerifierError("too-large", 413, "the image is larger than the 20971520 byte limit", undefined, {
      serviceCode: "the image is larger than the 20971520 byte limit",
      named: true,
    });
    expect(describeFailure(over, "prepare").key).toBe("tooLarge");
  });
});

describe("the sentences those keys print", () => {
  const LANGS = ["en", "de", "es", "fr", "hi", "ja", "ko", "pt", "ta", "zh"] as const;
  const files = LANGS.map((lang) => [lang, JSON.parse(readFileSync(`${MESSAGES}${lang}.json`, "utf8"))] as const);

  it("are in every language, for the edit panel and the studio", () => {
    for (const [lang, tree] of files) {
      for (const key of ["fingerprintUnstable", "signedFileTooLarge", "thumbnailTooLarge"]) {
        expect(typeof tree.passport.edit.failure[key], `${lang} passport.edit.failure.${key}`).toBe("string");
      }
      expect(typeof tree.studio.failure.signedFileTooLarge, `${lang} studio.failure.signedFileTooLarge`).toBe("string");
    }
  });

  it("say in English that nothing was pinned, and for an edit that nothing was sent", () => {
    const en = files[0][1];
    expect(en.passport.edit.failure.signedFileTooLarge).toBe(
      "Adding the passport's signature would take this file past 20 MB, the most a check can read back. Export it smaller and try again. Nothing was pinned or sent.",
    );
    expect(en.studio.failure.signedFileTooLarge).toBe(
      "Adding the passport's signature would take this file past 20 MB, the most a check can read back. Export it smaller and try again. Nothing was pinned.",
    );
    // The same advice the studio gives, so the reader always learns what would register.
    expect(en.passport.edit.failure.fingerprintUnstable).toBe(
      "This edit changes too little from side to side for a fingerprint that survives copying, so Chainlink's check and any search for its copies would miss it. Nothing was pinned or sent. An edit with more detail across its width will register.",
    );
    expect(en.passport.edit.failure.thumbnailTooLarge).toMatch(/Nothing was pinned or sent\.$/);
  });
});
