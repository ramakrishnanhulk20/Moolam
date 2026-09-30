import { accessSync, constants, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { Refusal } from "./cli";

/**
 * Where the setup scripts keep Dreamloom's secrets when run for real: packages/dreamloom/.env.local,
 * which git ignores. Tests hand every step a throwaway file instead, so they never open this one.
 *
 * Throws Refusal unless the scripts are run from packages/dreamloom, so a run from the repo root
 * cannot drop a wallet key into a file the Moolam packages read.
 */
export function dreamloomEnvFile(): string {
  const cwd = process.cwd();
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "dreamloom") {
    throw new Refusal("run the setup scripts from packages/dreamloom (npm run setup:<step> --workspace packages/dreamloom)");
  }
  return path.join(cwd, ".env.local");
}

/** The values an env file holds, parsed by Node's own parser; an absent file holds none. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
}

/** A value that is present and not blank. A blank line such as "DREAMLOOM_AGENT_ID=" is not a value. */
export function valueOf(values: Record<string, string>, name: string): string | undefined {
  const value = values[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** Throws Refusal naming the variable, never a value, when it is not set in the file. */
export function requiredValue(file: string, name: string): string {
  const value = valueOf(readEnvFile(file), name);
  if (value === undefined) throw new Refusal(`${name} is not set in ${file}`);
  return value;
}

/**
 * Checks the file could be written now, before a step spends anything whose result must land in it:
 * a key that is bound on chain but never saved is lost.
 */
export function assertWritable(file: string): void {
  try {
    accessSync(existsSync(file) ? file : path.dirname(file), constants.W_OK);
  } catch {
    throw new Refusal(`${file} cannot be written, so nothing was sent`);
  }
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
/** Hex keys, decimal ids and hostnames only: nothing that would need quoting or could start a second line. */
const PLAIN_VALUE = /^[A-Za-z0-9._:-]+$/;

/**
 * Writes one variable into an env file, keeping every other line as it was. A blank line for the same
 * name is replaced in place; a set value is refused unless `replace` is true, so a key made once is
 * never overwritten by a second run. The file is written whole to a temporary name and renamed over
 * the old one, so a crash leaves the old file or the new one, never half of either.
 *
 * Throws Refusal when the name is already set and `replace` is false.
 */
export function writeEnvValue(file: string, name: string, value: string, options: { replace?: boolean } = {}): void {
  if (!NAME.test(name) || !PLAIN_VALUE.test(value)) {
    throw new Error(`refusing to write ${name}: the name or the value is not in the plain form an env line needs`);
  }
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (valueOf(parseEnv(text) as Record<string, string>, name) !== undefined && options.replace !== true) {
    throw new Refusal(`${name} is already set in ${file}; nothing was changed`);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const line = `${name}=${value}`;
  const own = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
  const at = lines.findIndex((existing) => own.test(existing));
  const kept = lines.filter((existing) => !own.test(existing));
  if (at === -1) kept.push(line);
  else kept.splice(at, 0, line);
  const temporary = `${file}.writing`;
  writeFileSync(temporary, `${kept.join(eol)}${eol}`, { mode: 0o600 });
  renameSync(temporary, file);
}
