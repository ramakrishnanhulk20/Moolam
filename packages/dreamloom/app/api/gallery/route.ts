import { readGallery } from "@/lib/gallery";

// Read on request, never at build time: a build must not spend the index's allowance.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const answer = await readGallery();
  return Response.json(answer, {
    status: answer.state === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
