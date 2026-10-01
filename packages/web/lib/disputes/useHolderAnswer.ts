"use client";

import { usePrivy, useSignTypedData, useWallets } from "@privy-io/react-auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAddress, type Hex } from "viem";
import { getOwner } from "@/lib/chain/registry";
import { headTimestamp } from "@/lib/chain/time";
import { isUserCancellation } from "@/lib/errors/cancelled";
import {
  ANSWER_SIGNATURE_SECONDS,
  answerHashOf,
  answerText,
  answerTextProblem,
  walletTypedData,
  type AnswerDispute,
  type AnswerRefusal,
} from "./answer";
import { sendAnswer } from "./answerService";

/** Where one answer stands: being written, waiting on the wallet, on its way, or pinned. */
export type AnswerPhase = "idle" | "signing" | "sending" | "done";

export interface HolderAnswer {
  /** Privy has answered and the holder has been read, so the form can be drawn or left out for good. */
  ready: boolean;
  /** The signed in embedded wallet is the one ownerOf names right now. */
  isHolder: boolean;
  text: string;
  phase: AnswerPhase;
  refusal: AnswerRefusal | null;
  /** The pinned answer's address once the service took it. */
  answerURI: string | null;
  /** The words exactly as they were signed, kept to show the holder once the answer is pinned. */
  sent: string | null;
  setText: (text: string) => void;
  submit: () => Promise<void>;
}

/**
 * The holder's side of a challenge: write an answer, sign it, send it (L26).
 *
 * The wallet signs EIP-712 typed data and sends nothing to the chain, so it
 * costs no gas. The holder is read from ownerOf here rather than taken from the
 * page, because the page is held for a minute and the service checks ownerOf
 * at the moment the answer arrives. The deadline is counted from the chain's
 * head, which is the clock the service judges it by.
 */
export function useHolderAnswer({
  passportId,
  dispute,
  onAnswered,
}: {
  passportId: Hex;
  dispute: AnswerDispute;
  /** Called once the service holds an answer for this dispute, so the page can read it back. */
  onAnswered?: () => void;
}): HolderAnswer {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { signTypedData } = useSignTypedData();

  const wallet = useMemo(
    () => wallets.find((entry) => entry.walletClientType === "privy")?.address as Hex | undefined,
    [wallets],
  );

  const [holder, setHolder] = useState<{ passportId: Hex; holder: Hex | null } | null>(null);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<AnswerPhase>("idle");
  const [refusal, setRefusal] = useState<AnswerRefusal | null>(null);
  const [answerURI, setAnswerURI] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated || wallet === undefined) {
      return;
    }
    let live = true;
    void getOwner(passportId).then((owner) => {
      if (live) {
        setHolder({ passportId, holder: owner });
      }
    });
    return () => {
      live = false;
    };
  }, [authenticated, passportId, wallet]);

  const owner = holder !== null && holder.passportId === passportId ? holder.holder : undefined;
  const isHolder =
    wallet !== undefined && owner !== undefined && owner !== null && owner.toLowerCase() === wallet.toLowerCase();

  const submit = useCallback(async () => {
    if (wallet === undefined || phase === "signing" || phase === "sending" || phase === "done") {
      return;
    }
    const words = answerText(text);
    const problem = answerTextProblem(words);
    if (problem !== null) {
      setRefusal(problem);
      return;
    }
    if (!isHolder) {
      setRefusal("notHolder");
      return;
    }

    setRefusal(null);
    setPhase("signing");

    let deadline: bigint;
    try {
      deadline = (await headTimestamp()) + BigInt(ANSWER_SIGNATURE_SECONDS);
    } catch {
      setPhase("idle");
      setRefusal("chainUnreachable");
      return;
    }

    let signature: Hex;
    try {
      const typed = walletTypedData({
        passportId: passportId.toLowerCase() as Hex,
        openedAt: BigInt(dispute.openedAt),
        challenger: getAddress(dispute.challenger),
        answerHash: answerHashOf(words),
        deadline,
      });
      const signed = await signTypedData(typed, { address: wallet });
      signature = signed.signature as Hex;
    } catch (error) {
      setPhase("idle");
      setRefusal(isUserCancellation(error) ? "declined" : "unknown");
      return;
    }

    setPhase("sending");
    const answer = await sendAnswer({ passportId, text: words, deadline: Number(deadline), signature });
    if (answer.ok) {
      setAnswerURI(answer.answerURI);
      setSent(words);
      setPhase("done");
      onAnswered?.();
      return;
    }
    setPhase("idle");
    setRefusal(answer.refusal);
    // An answer the service already holds is on the page after one more read.
    if (answer.refusal === "alreadyAnswered") {
      onAnswered?.();
    }
  }, [dispute.challenger, dispute.openedAt, isHolder, onAnswered, passportId, phase, signTypedData, text, wallet]);

  return {
    ready: ready && (!authenticated || wallet === undefined || owner !== undefined),
    isHolder,
    text,
    phase,
    refusal,
    answerURI,
    sent,
    setText: (value: string) => {
      setText(value);
      if (refusal !== null && phase === "idle") {
        setRefusal(null);
      }
    },
    submit,
  };
}
