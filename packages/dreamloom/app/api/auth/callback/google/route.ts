import { googleCallback } from "@/lib/server/auth-routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return await googleCallback(request);
}
