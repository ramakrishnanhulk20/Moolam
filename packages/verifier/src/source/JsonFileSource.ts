import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { PassportRecord } from "../types.js";
import { hex } from "./hex.js";
import type { PassportSource } from "./PassportSource.js";

/**
 * phash arrives as a decimal string, not a JSON number, because a 64-bit hash
 * does not survive a double. Anything with a dot, a sign or 20-plus digits is
 * rejected rather than silently truncated.
 */
const recordSchema = z.object({
  id: hex(32),
  phash: z
    .string()
    .regex(/^[0-9]{1,20}$/, "phash must be a decimal string")
    .transform((value, ctx) => {
      const parsed = BigInt(value);
      if (parsed > 0xffffffffffffffffn) {
        ctx.addIssue({ code: "custom", message: "phash does not fit in 64 bits" });
        return z.NEVER;
      }
      return parsed;
    }),
  blockhash: hex(32),
  creator: hex(20),
  parentId: hex(32).nullable().default(null),
  registeredAt: z.number().int().nonnegative(),
  metadataURI: z.string(),
});

const fileSchema = z.array(recordSchema);

/** Reads passports from a JSON array on disk. Used in development and in tests. */
export class JsonFileSource implements PassportSource {
  constructor(private readonly filePath: string) {}

  /**
   * Reads and validates the file.
   *
   * A missing file gives an empty list, because a fresh clone that has not run
   * the seed yet should start the service rather than crash it. A file that
   * exists but is malformed throws, naming the record and the field, because
   * that is a real mistake and silently indexing nothing would hide it.
   */
  async load(): Promise<PassportRecord[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`PASSPORT_SOURCE_PATH ${this.filePath} is not valid JSON`);
    }

    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      const detail = result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`PASSPORT_SOURCE_PATH ${this.filePath} holds a bad passport list: ${detail}`);
    }
    return result.data;
  }
}
