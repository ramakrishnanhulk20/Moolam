import { cosignPicture } from "@/lib/server/routes";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return await cosignPicture(request, (await context.params).id);
}
