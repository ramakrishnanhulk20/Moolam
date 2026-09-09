---
title: Sign in and account
sidebar_label: Sign in and account
sidebar_position: 2
---

# Sign in and account

Most crypto apps open with "connect wallet", and most people stop there. Moolam opens with a sign
in, and the account is made for you while you wait.

## What signing in does

Press "Sign in and create my account" on the studio and pick email, Google or a passkey. Privy
checks whoever you said you were, then creates an embedded wallet for you on Monad in the same
step. The studio shows "Opening your account" while that runs.

The screen says it in three lines before you press anything:

- Your account: "Made the moment you sign in, held by Privy, and nobody at Moolam can sign with
  it."
- Your signature: "The fingerprint or face unlock on this device signs each image. It never leaves
  the device."
- The network fee: "Moolam pays it through Privy, so registering an image costs you nothing."

There is nothing to install, and no seed phrase to write down. The key lives in Privy's
infrastructure, not on a Moolam server, and Moolam never holds anything that can sign for you. What
signs your images is the passkey on your own device, covered in
[Your first passport](your-first-passport).

If you sign in and no account appears, the studio says so rather than pretending: "You are signed
in, but no account was created on Monad yet. Reload the page, or sign out and sign in again."

## The identity strip

Once you are in, a strip runs across the top of the studio with four fields and a "Sign out"
button.

| Field | What it shows |
| --- | --- |
| Signed in as | Your email or Google account. A passkey-only sign in reads a passkey, with no email on file |
| Your account | Your address on Monad, linked to MonadVision, with a copy button |
| Network | Monad mainnet, chain 143 |
| Network fee | Who paid, in one of three sentences |

The address is the one every passport you register names as its creator. Open it on MonadVision and
you can watch your own transactions land.

## Who pays the network fee

Registering an image is a real transaction on Monad, so somebody pays for it. Moolam pays, through
Privy's fee sponsorship.

The fee line is deliberately three different sentences, because only one of them is proved:

- "Paid by Moolam through Privy" is the claim, shown before any transaction of yours has landed. It
  is what the app is configured to do, not something this session has seen happen.
- "Paid by Moolam. Your balance did not move." appears after a transaction lands. The studio reads
  your balance immediately before the send and again after it is confirmed, and only says this when
  the second reading is not lower than the first.
- "Paid from your own balance" appears when you paid.

## If sponsorship is off

Sponsorship is a setting on Moolam's Privy account with credits behind it. If those credits run out,
or the setting is turned off, Privy refuses the send before it reaches Monad and the studio says:
"Privy would not pay the network fee for this transaction. What it said is below. You can send the
same transaction and pay the fee yourself."

Under that it prints Privy's own words, a line reading how much MON your account holds, and a
button, "Send it and pay the fee myself". Pressing it sends the exact same bytes you already
signed, this time from your own balance. Nothing is signed a second time.

A register costs 254,429 gas at the median and a one-time passkey bind costs 117,165, measured in
Foundry's Monad network family. Monad bills the gas limit you declare rather than the gas you use,
so a self-paid register is worth having a small amount of MON on hand for.

## Signing out

"Sign out" ends the Privy session in this browser. It does not touch anything on chain: your
account, your passkey binding and every passport you registered stay exactly where they are. Sign
in again with the same email or Google account and the same account comes back.
