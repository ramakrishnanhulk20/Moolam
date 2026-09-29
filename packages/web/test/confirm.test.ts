import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { ConfirmTimeout, confirmBind, confirmRegister, transactionHash } from "@/lib/studio/confirm";

const reads = vi.hoisted(() => ({
  bindNonce: vi.fn(),
  getPasskey: vi.fn(),
  getPassport: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  passportRegistration: vi.fn(),
  activeSource: vi.fn(() => "envio"),
}));

vi.mock("@/lib/chain/client", () => ({
  chain: { waitForTransactionReceipt: reads.waitForTransactionReceipt },
}));

vi.mock("@/lib/chain/registry", () => ({
  bindNonce: reads.bindNonce,
  getPasskey: reads.getPasskey,
  getPassport: reads.getPassport,
}));

vi.mock("@/lib/data/passports", () => ({ passportRegistration: reads.passportRegistration }));

vi.mock("@/lib/data/source", () => ({ activeSource: reads.activeSource }));

const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const ID = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"ef".repeat(32)}` as Hex;
const PASSPORT = { id: ID, registeredAt: 1_788_876_542n };
const KEY = { qx: `0x${"aa".repeat(32)}` as Hex, qy: `0x${"bb".repeat(32)}` as Hex };
const OTHER = { qx: `0x${"cc".repeat(32)}` as Hex, qy: `0x${"dd".repeat(32)}` as Hex };
const BIND = { wallet: WALLET, qx: KEY.qx, qy: KEY.qy, nonceBefore: 3n };

beforeEach(() => {
  vi.useFakeTimers();
  // A wait that keeps going after a read throws says so out loud, and the log
  // is not what these tests are about.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  reads.activeSource.mockReturnValue("envio");
});

describe("a hash a wallet handed back", () => {
  it("takes 0x and 64 hex characters, and treats anything else as absent", () => {
    expect(transactionHash(HASH)).toBe(HASH);
    expect(transactionHash("")).toBeUndefined();
    expect(transactionHash(null)).toBeUndefined();
    expect(transactionHash(undefined)).toBeUndefined();
    expect(transactionHash("0x1234")).toBeUndefined();
    expect(transactionHash(`0x${"zz".repeat(32)}`)).toBeUndefined();
  });
});

describe("confirming a bind by the key the registry holds", () => {
  it("lands on the third poll, with no hash to wait on at all", async () => {
    reads.bindNonce.mockResolvedValueOnce(3n).mockResolvedValueOnce(3n).mockResolvedValueOnce(4n);
    reads.getPasskey.mockResolvedValue(KEY);

    const confirming = confirmBind({ ...BIND, hash: "" });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(confirming).resolves.toEqual({ landed: true });
    expect(reads.bindNonce).toHaveBeenCalledTimes(3);
    expect(reads.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("waits for the key this device made, not for any key at all", async () => {
    // The nonce moved, so something was bound. It is another device's key, and
    // a browser that took this as its own answer would remember a credential
    // the registry has already replaced.
    reads.bindNonce.mockResolvedValue(4n);
    reads.getPasskey.mockResolvedValue(OTHER);

    const confirming = confirmBind({ ...BIND, hash: "" });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    expect(await thrown).toBeInstanceOf(ConfirmTimeout);
  });

  it("carries on through a read that throws and answers on the next one", async () => {
    reads.bindNonce.mockRejectedValueOnce(new Error("the RPC dropped the connection")).mockResolvedValue(4n);
    reads.getPasskey.mockResolvedValue(KEY);

    const confirming = confirmBind({ ...BIND, hash: "" });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirming).resolves.toEqual({ landed: true });
  });

  it("hands back a hash only once a receipt says that transaction succeeded", async () => {
    reads.bindNonce.mockResolvedValueOnce(3n).mockResolvedValue(4n);
    reads.getPasskey.mockResolvedValue(KEY);
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 42n });

    await expect(confirmBind({ ...BIND, hash: HASH })).resolves.toEqual({ landed: true, hash: HASH });
  });

  it("says the bind landed with no link at all when no receipt ever came back", async () => {
    reads.bindNonce.mockResolvedValue(4n);
    reads.getPasskey.mockResolvedValue(KEY);
    reads.waitForTransactionReceipt.mockReturnValue(new Promise(() => undefined));

    const confirming = confirmBind({ ...BIND, hash: HASH });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirming).resolves.toEqual({ landed: true });
  });

  it("gives up after ninety seconds and says the send may still land", async () => {
    reads.bindNonce.mockResolvedValue(3n);
    reads.getPasskey.mockResolvedValue(null);

    const confirming = confirmBind({ ...BIND, hash: "" });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    const error = await thrown;
    expect(error).toBeInstanceOf(ConfirmTimeout);
    expect((error as ConfirmTimeout).message).toContain("must not be sent again");
  });
});

describe("confirming a registration by the passport the registry holds", () => {
  it("lands on the third poll and reads the time off the record", async () => {
    reads.getPassport.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(PASSPORT);
    reads.passportRegistration.mockResolvedValue({ registeredBlock: 103_059_393n, txHash: HASH });

    const confirming = confirmRegister({ exactHash: ID, hash: "" });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(confirming).resolves.toEqual({
      landed: true,
      answeredAt: expect.any(Number),
      hash: HASH,
      blockNumber: 103_059_393n,
      registeredAt: 1_788_876_542_000,
    });
    expect(reads.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("waits for the index to catch up before it gives the receipt a transaction link", async () => {
    reads.getPassport.mockResolvedValue(PASSPORT);
    reads.passportRegistration
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ registeredBlock: 7n, txHash: HASH });

    const confirming = confirmRegister({ exactHash: ID, hash: "" });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirming).resolves.toMatchObject({ hash: HASH, blockNumber: 7n });
    expect(reads.passportRegistration).toHaveBeenCalledTimes(2);
  });

  it("still confirms when there is no index to ask", async () => {
    reads.activeSource.mockReturnValue("chain");
    reads.getPassport.mockResolvedValue(PASSPORT);

    await expect(confirmRegister({ exactHash: ID, hash: "" })).resolves.toEqual({
      landed: true,
      answeredAt: expect.any(Number),
      registeredAt: 1_788_876_542_000,
    });
    expect(reads.passportRegistration).not.toHaveBeenCalled();
  });

  it("takes the receipt when it arrives before the read does", async () => {
    reads.getPassport.mockResolvedValueOnce(null).mockResolvedValue(PASSPORT);
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 42n });

    await expect(confirmRegister({ exactHash: ID, hash: HASH })).resolves.toEqual({
      landed: true,
      answeredAt: expect.any(Number),
      hash: HASH,
      registeredAt: 1_788_876_542_000,
    });
    expect(reads.passportRegistration).not.toHaveBeenCalled();
  });

  it("carries on through a read that throws, and confirms on the one after it", async () => {
    reads.getPassport
      .mockRejectedValueOnce(new Error("the RPC dropped the connection"))
      .mockResolvedValue(PASSPORT);
    reads.activeSource.mockReturnValue("chain");

    const confirming = confirmRegister({ exactHash: ID, hash: "" });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirming).resolves.toMatchObject({ landed: true, registeredAt: 1_788_876_542_000 });
    expect(reads.getPassport).toHaveBeenCalledTimes(2);
  });

  it("does not read a passport somebody else wrote as this send landing", async () => {
    reads.getPassport.mockResolvedValue(PASSPORT);
    reads.activeSource.mockReturnValue("chain");

    const confirming = confirmRegister({ exactHash: ID, hash: "", registeredBefore: PASSPORT.registeredAt });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    expect(await thrown).toBeInstanceOf(ConfirmTimeout);
  });

  it("says so when the receipt comes back reverted", async () => {
    reads.getPassport.mockResolvedValue(null);
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "reverted", blockNumber: 42n });

    const confirming = confirmRegister({ exactHash: ID, hash: HASH });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await thrown).toMatchObject({ message: `Monad mined this transaction and it reverted: ${HASH}` });
  });

  it("ignores a receipt that never arrives and lets the state poll answer", async () => {
    reads.getPassport.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(PASSPORT);
    reads.waitForTransactionReceipt.mockRejectedValue(new Error("Timed out while waiting for transaction"));

    const confirming = confirmRegister({ exactHash: ID, hash: HASH });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(confirming).resolves.toMatchObject({ landed: true, hash: HASH });
  });
});
