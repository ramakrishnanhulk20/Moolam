import { readFile } from "node:fs/promises";
import { contentTypeFor, resolveDocsFile, servableFiles } from "@/lib/docs/files";

export const dynamic = "force-static";
/** Only the files listed below exist here, so anything else is a 404 with no code run. */
export const dynamicParams = false;

export function generateStaticParams() {
  return servableFiles().map((file) => ({ path: file.split("/") }));
}

/**
 * The attack transcripts and the proof runs the docs link to, served as they
 * are. They are written into the repo by `npm run prove`, so this route reads
 * them at build time rather than keeping a second copy of each one.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const file = resolveDocsFile(path);
  if (file === null) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const body = await readFile(file);
  return new Response(new Uint8Array(body), {
    headers: { "content-type": contentTypeFor(file), "x-content-type-options": "nosniff" },
  });
}
