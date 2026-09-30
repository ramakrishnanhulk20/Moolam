import { getPicture } from "@/lib/server/routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return await getPicture(request, (await context.params).id);
}
