# Deployments

One file per network, written by the deploy script, never by hand.

`monad-mainnet.json` appears after `npm run deploy:mainnet` and holds:

| Key | What it is |
| --- | --- |
| `chainId` | 143, Monad mainnet |
| `deployer` | The wallet that sent the deploy and owns the policy and the registry |
| `block` | The block the registry landed in, filled by the record step |
| `timestamp` | The chain head timestamp when the deploy was sent |
| `policy` | VerifierPolicy address |
| `registry` | MoolamRegistry address |
| `receiver` | MoolamReceiver address |
| `agentIdentity` | The canonical ERC-8004 Identity Registry the registry reads agent ownership from |
| `forwarder` | The Chainlink KeystoneForwarder the receiver accepts reports from |
| `txHashes` | Hashes of the three deploys and the two policy calls |
| `demoAgentId` | The ERC-8004 agent id of the demo generator, added by `npm run agent:register` |

The deploy runs in two halves on purpose. A Foundry script cannot see its own transaction hashes,
because the batch is only sent after the script returns, so the second half reads Foundry's own
broadcast artifact and fills the hashes in.

Nothing in this folder is a secret. The addresses are public the moment the transactions land.
