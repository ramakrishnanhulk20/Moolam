import { currentAccount } from "@/lib/server/auth-routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return await currentAccount(request);
}
