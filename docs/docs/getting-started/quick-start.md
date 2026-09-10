---
title: Quick start
sidebar_label: Quick start
sidebar_position: 1
---

# Quick start

Two minutes, two things: ask the registry which passport a copy belongs to, then put an image of
your own into it. Nothing here needs a wallet extension, a seed phrase or any MON.

The app is at https://moolam-rams-projects-86cea8eb.vercel.app. It is a Next.js app deployed on Vercel, and it reads Monad mainnet
directly, so what you see on it is the chain.

## 1. Check a copy, before signing in to anything

Open the home page and scroll to the panel headed "Drop any copy of any image here, or choose a
file". Drop any image you have, or press "Choose a file". The full page for this is "Verify an
image" in the header.

The file goes from your browser straight to the Moolam verify service. It is fingerprinted three
ways, tried in all eight rotations and mirrors, and matched against every registered passport. The
answer card turns over with one of three results:

- "Exact bytes match", when the file is byte for byte a registered one.
- "Match found", with a confidence percentage, when it is a re-encoded, resized, turned or mirrored
  copy.
- "Not registered" over "No passport matches this image.", when nothing in the registry is close
  enough.

A picture straight out of a generator that nobody registered gives the third answer, which is the
honest one. To see the first two, take an image off any passport page, re-save it at a lower
quality, and drop that in.

On a match, press "Open the passport" and you land on the record: who registered it, when, the
hashes a verifier recomputes, and any independent re-check written back on chain.

## 2. Register an image of your own

Press "Register an image" in the header.

1. Press "Sign in and create my account". Sign in with email, Google or a passkey. Privy makes an
   account for you on Monad while you wait. There is nothing to install and no seed phrase.
2. Press "Use this device's unlock". Your device asks for a fingerprint, a face or a PIN twice:
   once to make the passkey, once to sign the message that attaches it to your account. Moolam
   sends that to Monad and pays the network fee. The card reads "Bound" when it lands.
3. Drop a picture on "Drop an image here", type something in "Title", and press "Register this
   image". Three steps run in order: the file is fingerprinted and pinned to IPFS, your device asks
   for your unlock once more, and the transaction goes to Monad.
4. The card turns into "This image now has a passport", with the passport id, the block, and links
   to the passport page, the transaction and the pinned file.

Register the same file a second time and the registry refuses it. First registration wins, and the
screen offers you the passport that already holds it.

## Where to go next

- [Sign in and account](sign-in-and-account) explains what the account is and who pays the fee.
- [Your first passport](your-first-passport) walks the passkey and the three register steps slowly,
  with every wait and every failure.
- [Verify a copy](../guides/verify-a-copy) says what the answer card means and what does not match.
- [How it works](../concepts/how-it-works) is the life of one passport end to end.
