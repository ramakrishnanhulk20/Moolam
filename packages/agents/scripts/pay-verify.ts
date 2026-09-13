import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { config as loadEnv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });

/** Monad mainnet in the CAIP-2 form x402 uses. This client pays on that chain and no other. */
const NETWORK = "eip155:143";

/** USDC on Monad mainnet has six decimals, so 50000 atomic units is five cents. */
const USDC_DECIMALS = 6;

const DEFAULT_IMAGE = join(REPO_ROOT, "packages", "verifier", "test-assets", "original.jpg");

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

interface VerifyAnswer {
  result?: {
    exact: string | null;
    best: { id: string; phashDistance: number; blockhashDistance: number; variant: string } | null;
    confidence: number;
  };
  manifest?: { present: boolean };
  error?: string;
}

class Refused extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Refused(`${name} is not set. Put it in the repo root .env, next to the other keys.`);
  }
  return value;
}

function usdc(atomic: string): string {
  const units = BigInt(atomic);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction.length === 0 ? `${whole} USDC` : `${whole}.${fraction} USDC`;
}

async function main(): Promise<void> {
  const payerKey = required("X402_PAYER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(payerKey)) {
    throw new Refused("X402_PAYER_PRIVATE_KEY must be 0x followed by 64 hex characters");
  }
  const base = required("X402_VERIFIER_URL").replace(/\/$/, "");
  const imagePath = resolve(process.argv[2] ?? DEFAULT_IMAGE);
  const account = privateKeyToAccount(payerKey as `0x${string}`);
  const url = `${base}/verify/paid`;

  console.log("Moolam paid verification over x402, on Monad mainnet.");
  console.log(`Verifier ${url}`);
  console.log(`Payer    ${account.address}`);
  console.log(`Image    ${imagePath}`);
  console.log();

  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  const http = new x402HTTPClient(client);

  const unpaid = await fetch(url, { method: "POST" }).catch((error: unknown) => {
    throw new Refused(`the verifier did not answer: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (unpaid.status === 404) {
    throw new Refused("the verifier has the paid route switched off. Set X402_ENABLED=true and X402_PAY_TO_ADDRESS on it.");
  }
  if (unpaid.status !== 402) {
    throw new Refused(`expected 402 and the payment terms, got ${unpaid.status}`);
  }

  const terms = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), await unpaid.json());
  const accepted = terms.accepts.find((option) => option.network === NETWORK && option.scheme === "exact");
  if (accepted === undefined) {
    throw new Refused(`the verifier takes none of the payments this client can make: ${JSON.stringify(terms.accepts)}`);
  }

  console.log("Terms offered and accepted:");
  console.log(`  scheme    ${accepted.scheme} on ${accepted.network}`);
  console.log(`  price     ${usdc(accepted.amount)} (${accepted.amount} atomic units)`);
  console.log(`  asset     ${accepted.asset}`);
  console.log(`  pay to    ${accepted.payTo}`);
  console.log(`  valid for ${accepted.maxTimeoutSeconds} seconds`);
  console.log();

  const bytes = await readFile(imagePath).catch((error: unknown) => {
    throw new Refused(`could not read ${imagePath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const form = new FormData();
  const type = IMAGE_TYPES[extname(imagePath).toLowerCase()] ?? "application/octet-stream";
  form.set("file", new File([new Uint8Array(bytes)], imagePath.split(/[\/]/).pop() ?? "image", { type }));

  console.log("Signing the transfer authorisation and sending the image ...");
  const paid = await wrapFetchWithPayment(fetch, client)(url, { method: "POST", body: form }).catch(
    (error: unknown) => {
      throw new Refused(`the payment could not be made: ${error instanceof Error ? error.message : String(error)}`);
    },
  );

  const answer = await http.processResponse(paid);
  const body = answer.body as VerifyAnswer;

  if (answer.status !== 200) {
    const reason = (answer.header as PaymentRequired | undefined)?.error ?? body?.error ?? "no reason given";
    throw new Refused(`the verifier answered ${answer.status}: ${reason}`);
  }

  const receipt = answer.header as SettleResponse | undefined;
  if (receipt === undefined) {
    throw new Refused("the answer carried no PAYMENT-RESPONSE, so nothing proves the payment settled");
  }
  if (receipt.success) {
    console.log(`Settled. Transaction ${receipt.transaction} on ${receipt.network}, paid by ${receipt.payer}.`);
  } else if (receipt.errorReason === "settlement_pending") {
    console.log(`Broadcast but not confirmed yet. Transaction ${receipt.transaction}. The facilitator finishes it.`);
  } else {
    throw new Refused(`the payment did not settle: ${receipt.errorReason ?? "no reason given"}`);
  }
  console.log();

  const result = body.result;
  if (result === undefined) {
    throw new Refused(`the verifier answered 200 without a result: ${JSON.stringify(body).slice(0, 200)}`);
  }
  console.log("Verification:");
  if (result.exact !== null) {
    console.log(`  these exact bytes are registered, passport ${result.exact}`);
  } else if (result.best !== null) {
    console.log(
      `  matches passport ${result.best.id}, ${result.best.phashDistance} of 64 bits apart, variant ${result.best.variant}`,
    );
  } else {
    console.log("  no registered passport matches this image");
  }
  console.log(`  confidence ${result.confidence}`);
  console.log(`  C2PA manifest ${body.manifest?.present === true ? "read from the file" : "not in the file"}`);
}

main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(error instanceof Refused ? `Refused: ${reason}` : `Failed: ${reason}`);
  process.exit(1);
});
