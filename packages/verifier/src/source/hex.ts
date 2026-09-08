import { z } from "zod";
import type { Hex } from "../types.js";

/**
 * A hex string of an exact byte length, lower-cased on the way in.
 *
 * Every passport id, fingerprint and address is compared as a string, so the
 * case has to be settled at the boundary: one source that spells an id in
 * capitals would otherwise never match the same id from another.
 */
export function hex(bytes: number): z.ZodType<Hex> {
  return z
    .string()
    .regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`), `must be 0x followed by ${bytes * 2} hex characters`)
    .transform((value) => value.toLowerCase() as Hex);
}
