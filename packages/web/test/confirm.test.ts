import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { ConfirmTimeout, confirmBind, confirmRegister, transactionHash } from "@/lib/studio/confirm";

const reads = vi.hoisted(() => ({
  bindNonce: vi.fn(),
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
  getPassport: reads.getPassport,
}));

vi.mock("@/lib/data/passports", () => ({ passportRegistration: reads.passportRegistration }));

vi.mock("@/lib/data/source", () => ({ activeSource: reads.activeSource }));

const WALLET = "0x559F357aDa3A96d11AEa679eC0D622E4AF15F67c" as Hex;
const ID = `0x${"ab".repeat(32)}` as Hex;
const HASH = `0x${"ef".repeat(32)}` as Hex;
const PASSPORT = { id: ID, registeredAt: 1_788_876_542n };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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

describe("confirming a bind by the nonce the registry holds", () => {
  it("lands on the third poll, with no hash to wait on at all", async () => {
    reads.bindNonce.mockResolvedValueOnce(3n).mockResolvedValueOnce(3n).mockResolvedValueOnce(4n);

    const confirming = confirmBind({ wallet: WALLET, nonceBefore: 3n, hash: "" });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(confirming).resolves.toEqual({ landed: true });
    expect(reads.bindNonce).toHaveBeenCalledTimes(3);
    expect(reads.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it("keeps the hash it was given once the nonce moves", async () => {
    reads.bindNonce.mockResolvedValueOnce(3n).mockResolvedValueOnce(4n);
    reads.waitForTransactionReceipt.mockReturnValue(new Promise(() => undefined));

    const confirming = confirmBind({ wallet: WALLET, nonceBefore: 3n, hash: HASH });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(confirming).resolves.toEqual({ landed: true, hash: HASH });
  });

  it("gives up after ninety seconds and says the send may still land", async () => {
    reads.bindNonce.mockResolvedValue(3n);

    const confirming = confirmBind({ wallet: WALLET, nonceBefore: 3n, hash: "" });
    const thrown = confirming.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(95_000);

    const error = await thrown;
    expect(error).toBeInstanceOf(ConfirmTimeout);
    expect((error as ConfirmTimeout).wallet).toBe(WALLET);
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
      registeredAt: 1_788_876_542_000,
    });
    expect(reads.passportRegistration).not.toHaveBeenCalled();
  });

  it("takes the receipt when it arrives before the read does", async () => {
    reads.getPassport.mockResolvedValueOnce(null).mockResolvedValue(PASSPORT);
    reads.waitForTransactionReceipt.mockResolvedValue({ status: "success", blockNumber: 42n });

    await expect(confirmRegister({ exactHash: ID, hash: HASH })).resolves.toEqual({
      landed: true,
      hash: HASH,
      blockNumber: 42n,
      registeredAt: 1_788_876_542_000,
    });
    expect(reads.passportRegistration).not.toHaveBeenCalled();
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
