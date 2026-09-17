import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ revalidateTag: vi.fn() }));

vi.mock("next/cache", () => ({
  revalidateTag: cache.revalidateTag,
  unstable_cache: (fn: unknown) => fn,
}));

const { refreshPassport } = await import("@/lib/passport/refresh");
const { passportTag } = await import("@/lib/chain/registry");

const ID = `0x${"CD".repeat(32)}`;

beforeEach(() => {
  cache.revalidateTag.mockReset();
});

describe("dropping what the site holds about one passport", () => {
  it("drops that passport's name and no other", async () => {
    await refreshPassport(ID);

    expect(cache.revalidateTag).toHaveBeenCalledTimes(1);
    // The second argument is what makes it immediate: without it Next hands the
    // old page out while it rebuilds, to the one person who must not get it.
    expect(cache.revalidateTag).toHaveBeenCalledWith(`passport:0x${"cd".repeat(32)}`, { expire: 0 });
    expect(passportTag(ID as `0x${string}`)).toBe(`passport:0x${"cd".repeat(32)}`);
  });

  it("drops nothing at all for anything that is not a passport id", async () => {
    // Anyone on the internet can call a server action, so every one of these is
    // a caller trying to name something the app never meant to hand them.
    for (const bad of ["", "0x", ID.slice(0, -1), `${ID}00`, "moolam-chain", "*", `0x${"zz".repeat(32)}`]) {
      await refreshPassport(bad);
    }

    expect(cache.revalidateTag).not.toHaveBeenCalled();
  });
});
