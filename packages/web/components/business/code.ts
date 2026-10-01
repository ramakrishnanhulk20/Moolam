import { VERIFY_URL } from "./content";

/**
 * The code the page shows, kept apart from the words: code is the same in
 * every language, and these are the real calls from the platform kit's guide.
 */
export const STEP_CODE = [
  `import { signAsAgent, startCosign, waitForCreator, waitForPassport } from "@moolam/platform";

const handle = await startCosign(picture, {
  verifyUrl: "${VERIFY_URL}",
  platformKey: process.env.MOOLAM_PLATFORM_KEY ?? "",
  agentAccount,
  publicClient,
  title: "A human standing alone on the moon",
  terms: { aiTraining: "notAllowed" },
});`,
  `// The link is the person's key to the page. Send it to them and to nobody else.
await sendToUser(handle.cosignUrl);

const digest = await waitForCreator(handle);
await signAsAgent(handle, digest);`,
  `const passport = await waitForPassport(handle);
console.log(\`\${passport.passportId} registered by \${passport.creator}\`);`,
] as const;

export const MCP_CODE = `claude mcp add --transport http moolam ${VERIFY_URL}/mcp`;
