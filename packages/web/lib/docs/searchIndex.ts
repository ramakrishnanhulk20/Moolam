import type { SearchEntry } from "./search";

type Fetch = (input: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

let pending: Promise<SearchEntry[]> | null = null;

/**
 * The docs search index, fetched once per visit and shared by every caller.
 *
 * The file is over half a megabyte. Focus, hover and the press on Search docs
 * each asked for it, and on a slow load eleven copies of the same download were
 * in flight at once. Now they all wait on one request. A failed download is
 * forgotten rather than kept, so the next open tries again instead of the box
 * answering "Nothing found" for the rest of the visit.
 */
export function loadSearchIndex(fetcher: Fetch = fetch): Promise<SearchEntry[]> {
  if (pending === null) {
    const request = fetcher("/docs-search")
      .then((answer) => {
        if (!answer.ok) {
          throw new Error("search index unavailable");
        }
        return answer.json() as Promise<SearchEntry[]>;
      })
      .catch((error: unknown) => {
        if (pending === request) {
          pending = null;
        }
        throw error;
      });
    pending = request;
  }
  return pending;
}
