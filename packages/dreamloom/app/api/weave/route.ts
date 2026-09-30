import { weave } from "@/lib/server/routes";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return await weave(request);
}
