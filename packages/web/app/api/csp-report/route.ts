import { NextResponse } from "next/server";
import { callerAddress, tooMany, withinLimit } from "@/lib/api/limit";

export const dynamic = "force-dynamic";

/**
 * How many reports one caller may send a minute. A page that trips the policy
 * trips it a handful of times on load; a script posting made up reports is not
 * a finding, and thirty is enough to see a real one without the log becoming
 * somewhere anyone can write.
 */
const REPORTS_PER_MINUTE = 30;

/** The most of any reported value that reaches the log, so a long address cannot flood a line. */
const FIELD_MAX = 200;

/** One violation, reduced to the three fields worth a line. */
interface Violation {
  document: string;
  directive: string;
  blocked: string;
}

/**
 * Where the browser sends a content policy violation.
 *
 * The policy ships report-only, which measures nothing at all unless something
 * collects what it would have blocked. This is that. One line per report goes
 * to the server log: the page, the rule it broke and what was blocked, each cut
 * to a readable length. The body itself is never logged, because a blocked
 * address can carry whatever was in the page it came from, and an extension in
 * a visitor's browser trips this route as readily as the app does.
 *
 * The answer is always 204. A browser that cannot post its report has nothing
 * to do with the answer, and a status with words in it would only tell someone
 * probing the route that it is worth probing.
 */
export async function POST(request: Request) {
  const rate = withinLimit("csp-report", callerAddress(request), Date.now(), REPORTS_PER_MINUTE);
  if (!rate.ok) {
    return tooMany(rate.retryAfter);
  }

  const body: unknown = await request.json().catch(() => null);
  for (const violation of violationsIn(body)) {
    console.warn(`csp-report ${violation.document} ${violation.directive} ${violation.blocked}`);
  }

  return new NextResponse(null, { status: 204 });
}

/**
 * The violations in one posted body, whichever way the browser sent them.
 *
 * report-uri posts a single object under a "csp-report" key with hyphenated
 * field names. report-to posts an array of reports, each with the violation
 * under "body" and the same fields in camel case. Both are read here, so the
 * policy can carry both and lose nothing to whichever the browser honours.
 */
function violationsIn(body: unknown): Violation[] {
  if (Array.isArray(body)) {
    return body.flatMap((entry) => violationOf(record(entry)?.body));
  }
  const single = record(body);
  return violationOf(single?.["csp-report"] ?? single);
}

function violationOf(entry: unknown): Violation[] {
  const found = record(entry);
  if (found === null) {
    return [];
  }

  const document = text(found["document-uri"] ?? found.documentURL);
  const directive = text(found["violated-directive"] ?? found.effectiveDirective);
  const blocked = text(found["blocked-uri"] ?? found.blockedURL);

  return document === "" && directive === "" ? [] : [{ document, directive, blocked }];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Newlines would let a reported address write a line of its own in the log. */
function text(value: unknown): string {
  return typeof value !== "string" ? "" : value.replace(/[\r\n]+/g, " ").slice(0, FIELD_MAX);
}
