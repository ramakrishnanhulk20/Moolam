import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const VERIFY_TIMEOUT_MS = 60_000;

/**
 * Passes an upload to the verifier service and hands its answer back unchanged.
 *
 * The browser never learns where the verifier lives: VERIFIER_BASE_URL stays on
 * the server, which is what lets the service sit on a private network later
 * without a line of this changing.
 */
export async function POST(request: Request) {
  const base = process.env.VERIFIER_BASE_URL ?? "http://localhost:4010";

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'send the image in a multipart field named "file"' }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'send the image in a multipart field named "file"' }, { status: 400 });
  }

  const outgoing = new FormData();
  outgoing.append("file", file, file.name);

  let response: Response;
  try {
    response = await fetch(new URL("/verify", base), {
      method: "POST",
      body: outgoing,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    return NextResponse.json({ error: "verifier-unreachable" }, { status: 503 });
  }

  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}
