import { signOut } from "@/lib/server/auth-routes";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return await signOut(request);
}
