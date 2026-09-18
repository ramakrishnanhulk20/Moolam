import { NextResponse } from "next/server";
import { reason } from "@/lib/chain/client";
import { consentAt, passportIdFrom, secondsFrom } from "@/lib/chain/consent";

export const dynamic = "force-dynamic";

/**
 * What was in force on one day, for the bench's scrubber.
 *
 * The bench is the only caller, so the route lives behind the same flag the lab
 * pages do and is a 404 everywhere else. It reads consentAt live rather than
 * through the hold: the whole point of the scrubber is that the answer belongs
 * to the moment it asked about, and the moment changes on every step.
 *
 * Both parameters are read here rather than trusted from whoever built the URL.
 * An id that is not 32 bytes of hex and a time that is not whole seconds are
 * refused with 400, so a malformed ask never reaches an eth_call.
 */
export async function GET(request: Request) {
  if (process.env.NEXT_PUBLIC_LAB_PAGES !== "1") {
    return NextResponse.json({ error: "this route only exists where the lab pages do" }, { status: 404 });
  }

  const asked = new URL(request.url).searchParams;
  const id = passportIdFrom(asked.get("id"));
  const at = secondsFrom(asked.get("at"));

  if (id === null) {
    return NextResponse.json({ error: "id must be a passport id: 32 bytes of hex" }, { status: 400 });
  }
  if (at === null) {
    return NextResponse.json({ error: "at must be a moment in whole seconds" }, { status: 400 });
  }

  try {
    const reading = await consentAt(id, at);
    return NextResponse.json({
      asked: at,
      stated: reading.stated,
      entry:
        reading.entry === null
          ? null
          : {
              at: Number(reading.entry.at),
              writer: reading.entry.writer,
              consent: reading.entry.consent,
              constraintInfo: reading.entry.constraintInfo,
            },
    });
  } catch (error) {
    return NextResponse.json({ error: reason(error) }, { status: 502 });
  }
}
