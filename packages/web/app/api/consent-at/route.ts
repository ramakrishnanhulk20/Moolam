import { NextResponse } from "next/server";
import { reason } from "@/lib/chain/client";
import { REGISTRY_DEPLOYED_AT, consentAt, passportIdFrom, secondsFrom } from "@/lib/chain/consent";

export const dynamic = "force-dynamic";

/** How long one answer is reused, here and in whatever shared cache sits in front of this app. */
const HOLD_SECONDS = 60;

/** A day past now, so a browser a few hours ahead of this server is still answered. */
const AHEAD_SECONDS = 86_400;

/**
 * The most moments remembered at once. A drag along the rule asks for one moment
 * per day of a passport's life, and every reader of the same passport asks about
 * the same days, so a few hundred answers covers a busy minute. The oldest leaves
 * when a new one arrives, so a flood of made up moments cannot grow this process.
 */
const HELD_MAX = 500;

interface Answer {
  asked: number;
  stated: boolean;
  entry: {
    at: number;
    writer: string;
    consent: Record<string, string>;
    constraintInfo: string;
  } | null;
}

const held = new Map<string, { at: number; answer: Answer }>();

/**
 * What the register held on one day, for the scrubber on a passport page.
 *
 * It reads consentAt live rather than through the page's hold: the whole point
 * of the scrubber is that the answer belongs to the moment it asked about, and
 * the moment changes on every step of the thumb.
 *
 * Both parameters are read here rather than trusted from whoever built the URL.
 * An id that is not 32 bytes of hex, and a moment before the registry existed or
 * more than a day ahead of now, are refused with 400, so a made up ask never
 * reaches the chain. A failed read is a 503 and carries no endpoint: the app may
 * be reading Monad through an address that is itself an access token.
 */
export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams;
  const id = passportIdFrom(asked.get("id"));
  const at = secondsFrom(asked.get("at"));
  const now = Math.floor(Date.now() / 1000);

  if (id === null) {
    return NextResponse.json({ error: "id must be a passport id: 32 bytes of hex" }, { status: 400 });
  }
  if (at === null || at < REGISTRY_DEPLOYED_AT || at > now + AHEAD_SECONDS) {
    return NextResponse.json({ error: "at must be a moment since the registry was deployed" }, { status: 400 });
  }

  const key = `${id}:${at}`;
  const remembered = held.get(key);
  if (remembered !== undefined && Date.now() - remembered.at < HOLD_SECONDS * 1_000) {
    return answered(remembered.answer);
  }

  try {
    const reading = await consentAt(id, at);
    const answer: Answer = {
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
    };

    remember(key, answer);
    return answered(answer);
  } catch (error) {
    // Never held: the next reader deserves a real attempt rather than this
    // minute's failure handed back to them.
    return NextResponse.json({ error: reason(error) }, { status: 503 });
  }
}

function answered(answer: Answer) {
  return NextResponse.json(answer, {
    headers: { "cache-control": `public, s-maxage=${HOLD_SECONDS}, stale-while-revalidate=${HOLD_SECONDS}` },
  });
}

function remember(key: string, answer: Answer) {
  if (held.size >= HELD_MAX) {
    const oldest = held.keys().next();
    if (!oldest.done) {
      held.delete(oldest.value);
    }
  }
  held.set(key, { at: Date.now(), answer });
}
