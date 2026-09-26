import type { Hex } from "viem";
import { readCard } from "@/components/agent/card";
import { FINDING_ID, chainlinkRecheck, type FindingRecheck } from "@/components/home/finding";
import { chainlinkReceivers } from "@/lib/chain/receivers";
import { heldConsent, plainStatement, type Statement } from "@/lib/chain/consent";
import { heldAgent, heldPassportRecord } from "@/lib/chain/registry";
import { heldArt } from "@/lib/data/passports";

/** One real passport, as the signed-out studio and My pictures show it. */
export interface ShowcasePassport {
  id: Hex;
  title: string | null;
  picture: string;
  creator: Hex;
  /** Null for a picture no agent signed. */
  agentId: string | null;
  /** The name on the agent's card, or null where the card has none or would not load. */
  agentName: string | null;
  /** Null when the register could not be read, which is not the same as nothing stated. */
  statement: Statement | null;
  recheck: FindingRecheck | null;
}

/**
 * The passport the home page's first screen is about, read through the same
 * one minute holds the passport page and the home page keep, so showing it
 * here costs the chain nothing new.
 *
 * Nothing is filled in: a record, a picture or a document that will not load
 * answers null, and the page then shows nothing beside the card. The agent's
 * name and the statement are each left out on their own when only they fail.
 */
export async function showcasePassport(id: Hex = FINDING_ID): Promise<ShowcasePassport | null> {
  try {
    const { passport, attestations } = await heldPassportRecord(id);
    if (passport === null) {
      return null;
    }

    const agentId = passport.generatorAgentId > 0n ? passport.generatorAgentId.toString() : null;
    const [art, said, agent] = await Promise.all([
      heldArt(passport.metadataURI, passport.id),
      heldConsent(passport.id).catch(() => null),
      agentId === null ? Promise.resolve(null) : heldAgent(agentId).catch(() => null),
    ]);

    const picture = art.thumbnailUrl ?? art.imageUrl ?? null;
    if (picture === null) {
      return null;
    }

    const name = agent === null ? null : (readCard(agent.card)?.name?.trim() ?? null);

    return {
      id: passport.id,
      title: art.title ?? null,
      picture,
      creator: passport.creator,
      agentId,
      agentName: name === "" ? null : name,
      statement:
        said === null ? null : said.stated && said.entry !== null ? plainStatement(said.entry.consent) : "none",
      recheck: chainlinkRecheck(attestations, chainlinkReceivers()),
    };
  } catch {
    return null;
  }
}
