import { NextResponse } from "next/server";
import { z } from "zod";
import { reason } from "@/lib/chain/client";
import { latestPassports } from "@/lib/data/passports";

export const dynamic = "force-dynamic";

const limitSchema = z.coerce.number().int().min(1).max(24).catch(6);

/**
 * The newest passports as JSON, for anything on the client that wants the strip
 * without a page reload. Every number goes out as a string: a passport id and a
 * 64-bit fingerprint do not survive a JSON number.
 */
export async function GET(request: Request) {
  const limit = limitSchema.parse(new URL(request.url).searchParams.get("limit"));

  try {
    const { source, passports } = await latestPassports(limit);
    return NextResponse.json({
      source,
      passports: passports.map((passport) => ({
        id: passport.id,
        creator: passport.creator,
        agentId: passport.agentId.toString(),
        registeredAt: passport.registeredAt.toString(),
        blockNumber: passport.blockNumber.toString(),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: reason(error) }, { status: 502 });
  }
}
