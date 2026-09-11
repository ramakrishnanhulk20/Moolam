import { buildSearchIndex } from "@/lib/docs/search";

export const dynamic = "force-static";

/**
 * The search index, built once with the site and fetched by the search box the
 * first time someone opens it. It carries no language because the pages do not:
 * the docs are written in English whichever language the chrome is in.
 */
export async function GET() {
  return Response.json(await buildSearchIndex());
}
