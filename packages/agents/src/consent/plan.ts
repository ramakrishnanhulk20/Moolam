import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { z } from "zod";
import {
  firstUnprintableByte,
  infoByteLength,
  isConstrained,
  MAX_INFO_BYTES,
  USE_FIELDS,
  USE_WORDS,
  type ConsentWords,
  type Statement,
} from "./statements.js";

/** A passport id as the registry writes it: the sha256 of the picture, 32 bytes of hex. */
const PASSPORT_ID = /^0x[0-9a-fA-F]{64}$/;

const useWord = z.enum(USE_WORDS);

const consentWords = z.strictObject({
  aiTraining: useWord,
  aiGenerativeTraining: useWord,
  aiInference: useWord,
  dataMining: useWord,
});

const statementSchema = z.strictObject({
  name: z.string().min(1, "a statement needs a name"),
  consent: consentWords,
  constraintInfo: z.string().optional(),
});

/**
 * The plan file as it is written on disk.
 *
 * Unknown keys are refused rather than dropped: a misspelled field in a file that decides what a
 * creator's pictures say about AI is a question for a human, not something to quietly ignore.
 */
const planSchema = z
  .strictObject({
    statements: z.array(statementSchema).min(1, "the plan needs at least one statement"),
    passports: z.record(z.string(), z.string().min(1, "every passport needs a statement name")),
  })
  .superRefine((plan, ctx) => {
    const names = new Set<string>();
    for (const [index, statement] of plan.statements.entries()) {
      if (names.has(statement.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["statements", index, "name"],
          message: `two statements are both called "${statement.name}"`,
        });
      }
      names.add(statement.name);
      checkConstraintInfo(statement.consent, statement.constraintInfo, ["statements", index], ctx);
    }

    const seen = new Map<string, string>();
    const ids = Object.keys(plan.passports);
    if (ids.length === 0) {
      ctx.addIssue({ code: "custom", path: ["passports"], message: "the plan names no passports" });
    }
    for (const id of ids) {
      if (!PASSPORT_ID.test(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["passports", id],
          message: `${id} is not a passport id: it must be 0x and 64 hex characters`,
        });
        continue;
      }

      const normalised = id.toLowerCase();
      const first = seen.get(normalised);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["passports", id],
          message: `${id} is the same passport as ${first} in different case`,
        });
      }
      seen.set(normalised, id);

      const wanted = plan.passports[id];
      if (wanted !== undefined && !names.has(wanted)) {
        ctx.addIssue({
          code: "custom",
          path: ["passports", id],
          message: `there is no statement called "${wanted}"`,
        });
      }
    }
  });

/**
 * The constraint text rules, the same three the contract checks, applied here so a plan that
 * would revert never reaches the chain: required exactly when a use is constrained, at most
 * MAX_INFO_BYTES bytes, printable ASCII throughout.
 */
function checkConstraintInfo(
  consent: ConsentWords,
  text: string | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const constrained = isConstrained(consent);
  const at = [...path, "constraintInfo"];

  if (!constrained) {
    if (text !== undefined && text.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: at,
        message: "constraintInfo belongs to a constrained use, and no use here is constrained",
      });
    }
    return;
  }

  if (text === undefined || text.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: at,
      message: "a constrained use needs constraintInfo saying how to ask",
    });
    return;
  }

  const bytes = infoByteLength(text);
  if (bytes > MAX_INFO_BYTES) {
    ctx.addIssue({
      code: "custom",
      path: at,
      message: `constraintInfo is ${bytes} bytes and the contract allows ${MAX_INFO_BYTES}`,
    });
  }

  const bad = firstUnprintableByte(text);
  if (bad >= 0) {
    ctx.addIssue({
      code: "custom",
      path: at,
      message: `constraintInfo has a byte at position ${bad} that is not printable ASCII`,
    });
  }
}

/** One passport and the statement the plan wants it to carry. */
export interface PlanEntry {
  passportId: Hex;
  statement: Statement;
}

export interface Plan {
  statements: Map<string, Statement>;
  entries: PlanEntry[];
}

/** A plan that cannot be used, with every problem found in it rather than only the first. */
export class PlanError extends Error {
  readonly problems: string[];

  constructor(file: string, problems: string[]) {
    super(`${file} is not a usable consent plan:\n  ${problems.join("\n  ")}`);
    this.name = "PlanError";
    this.problems = problems;
  }
}

/**
 * Checks a parsed plan and turns it into the list the rest of the script works from.
 *
 * Every passport id is lowercased here and nowhere else, so the ids compared against the chain and
 * the ids sent in the calldata come out of this one place.
 *
 * Throws PlanError listing every problem: an unknown statement name, a malformed id, a duplicate,
 * or a constraint text the contract would refuse.
 */
export function parsePlan(value: unknown, file = "the plan"): Plan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${where}${issue.message}`;
    });
    throw new PlanError(file, problems);
  }

  const statements = new Map<string, Statement>();
  for (const statement of parsed.data.statements) {
    statements.set(statement.name, {
      name: statement.name,
      consent: pickConsent(statement.consent),
      constraintInfo: statement.constraintInfo ?? "",
    });
  }

  const entries: PlanEntry[] = [];
  for (const [id, name] of Object.entries(parsed.data.passports)) {
    const statement = statements.get(name);
    if (statement === undefined) {
      throw new PlanError(file, [`there is no statement called "${name}"`]);
    }
    entries.push({ passportId: id.toLowerCase() as Hex, statement });
  }

  return { statements, entries };
}

/** Reads and checks the plan file. Throws PlanError when the file is missing or is not JSON. */
export function loadPlan(file: string): Plan {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new PlanError(file, ["there is no file there"]);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new PlanError(file, [`it is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }

  return parsePlan(value, file);
}

function pickConsent(consent: ConsentWords): ConsentWords {
  const picked = {} as ConsentWords;
  for (const field of USE_FIELDS) {
    picked[field] = consent[field];
  }
  return picked;
}
