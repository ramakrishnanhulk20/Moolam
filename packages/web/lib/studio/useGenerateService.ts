"use client";

import { useEffect, useState } from "react";
import { readGenerateService, type GenerateService } from "@/lib/verifier/client";

/**
 * Whether the verify service can draw pictures, asked once when the studio opens.
 *
 * It is one small read of /health, which the service answers without counting it
 * against anyone's limit, and the answer is held for as long as the studio is on
 * screen. A person who reaches the agent path while it is switched off would
 * otherwise type a prompt, press, and only then be told. Until the answer lands,
 * and when it never does, the agent is offered exactly as it always was.
 */
export function useGenerateService(): GenerateService["state"] {
  const [state, setState] = useState<GenerateService["state"]>("unknown");

  useEffect(() => {
    const asking = new AbortController();
    void readGenerateService({ signal: asking.signal }).then((answer) => {
      if (!asking.signal.aborted) {
        setState(answer.state);
      }
    });
    return () => asking.abort();
  }, []);

  return state;
}
