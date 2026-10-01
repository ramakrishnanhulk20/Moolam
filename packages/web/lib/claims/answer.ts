import { acceptClaims, refuseClaims, type ClaimOutcome, type ClaimTerms, type ClaimsAnswer, type Fetcher } from "./client";
import { inBatches, ticketsFor } from "./offers";

/**
 * A person's answer to one platform, sent as the service takes it.
 *
 * Both answers act on that platform's offers and no other's, in calls of at
 * most 32 ids (P32). A refusal stops the run where it is: what went before it
 * was answered, and the list read again afterwards shows exactly what was.
 */

/** "These are mine" for every offer this platform made, with the person's AI-use terms. */
export async function sayMine(
  answer: ClaimsAnswer,
  platformKeyHash: string,
  choice: { terms: ClaimTerms; sendFuture: boolean },
  token: string,
  fetcher?: Fetcher,
): Promise<ClaimOutcome<string[]>> {
  const done: string[] = [];
  for (const ticketIds of inBatches(ticketsFor(answer.offers, platformKeyHash))) {
    const outcome = await acceptClaims({ ticketIds, terms: choice.terms, sendFuture: choice.sendFuture }, token, fetcher);
    if (!outcome.ok) return outcome;
    done.push(...outcome.value.accepted);
  }
  return { ok: true, value: done };
}

/** "Not mine" for every offer this platform made. */
export async function sayNotMine(
  answer: ClaimsAnswer,
  platformKeyHash: string,
  token: string,
  fetcher?: Fetcher,
): Promise<ClaimOutcome<string[]>> {
  const done: string[] = [];
  for (const ticketIds of inBatches(ticketsFor(answer.offers, platformKeyHash))) {
    const outcome = await refuseClaims(ticketIds, token, fetcher);
    if (!outcome.ok) return outcome;
    done.push(...outcome.value.refused);
  }
  return { ok: true, value: done };
}
