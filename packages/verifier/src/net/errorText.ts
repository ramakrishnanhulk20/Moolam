const ADDRESS_IN_TEXT = /https?:\/\/[^\s"'<>`]+/gi;
const ADDRESS_LINE = /^\s*(URL|Request body):/;

function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return "(an address)";
  }
}

/**
 * The text of a caught error, safe to put in a log line or an answer.
 *
 * viem writes the endpoint it called into its errors as a "URL:" line, and a dedicated RPC
 * endpoint's path is its access token, so a viem error is told by its name and short message only,
 * every other error by its message, and in both every web address is cut to its origin and every
 * "URL:" or "Request body:" line is dropped. An address that does not parse is dropped whole.
 */
export function safeReason(error: unknown): string {
  let text = String(error);
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    text = typeof short === "string" && short.length > 0 ? `${error.name}: ${short}` : error.message;
  }
  return text
    .split("\n")
    .filter((line) => !ADDRESS_LINE.test(line))
    .map((line) => line.replace(ADDRESS_IN_TEXT, originOf))
    .join("\n");
}
