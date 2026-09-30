import { forgetOwnAddress, getRemembered, rememberOwnAddress } from "@/lib/server/routes";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return await getRemembered(request);
}

export async function POST(request: Request): Promise<Response> {
  return await rememberOwnAddress(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return await forgetOwnAddress(request);
}
