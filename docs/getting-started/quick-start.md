---
title: Quick start
---

# Quick start

Two minutes, two things: ask the registry which passport a copy belongs to, then put an image of
your own into it. Nothing here needs a wallet extension, a seed phrase or any MON.

The app is at https://moolam.vercel.app. It is a Next.js app deployed on Vercel, and it reads Monad mainnet
directly, so what you see on it is the chain.

The first time you open the home page, a short walk of three steps points at the three things to
press: "Verify an image", "Register an image" and "My pictures". Press "Next" to go through it or
"Skip" to close it. It shows once per device, and not at all on a device that has signed in here
before. To see it again, press "Show the guide again" in the footer of any page, beside Docs,
Privacy and Terms, and the walk opens on the home page.

## 1. Check a copy, before signing in to anything

Open the home page and scroll to the panel headed "Drop any copy of any image here, or choose a
file". Drop any image you have, or press "Choose a file". The full page for this is "Verify an
image" in the header.

The file goes from your browser straight to the Moolam verify service, never through the app's own
server, and it is not stored. It is fingerprinted three ways, tried in all eight rotations and
mirrors, and matched against every registered passport. The answer card turns over with one of
three results:

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
3. Pick one of the two ways in, headed "Two ways in": "Upload a picture", one you already made, or
   "Make one with the agent", which draws it for you. The panel under the choice changes with it.

**Uploading.** Drop a picture on "Drop an image here", type something in "Title", and press
"Register this image". Three steps run in order: the file is fingerprinted and pinned to IPFS, your
device asks for your unlock once more, and the transaction goes to Monad. The card turns into "This
image now has a passport", with the passport id, the block, and links to the passport page, the
transaction and the pinned file.

**With the agent.** Type a prompt, or press one of the three under "Or start from one of these",
give it a title, and press "Make and register". Five steps run: the agent draws the picture, the
picture is pinned to IPFS, the agent signs the passport with its own wallet, your unlock signs the
same passport, and the transaction goes to Monad. The card turns into "An agent made this, and you
both signed for it", with the model that drew it and a link to the agent's own page. The line under
the button reads "1 of 3 today", which is the daily allowance per account.

Register the same file a second time and the registry refuses it. First registration wins, and the
screen offers you the passport that already holds it.

## Where to go next

- [Sign in and account](sign-in-and-account) explains what the account is and who pays the fee.
- [Your first passport](your-first-passport) walks the passkey and both register paths slowly, with
  every wait and every failure.
- [Verify a copy](../guides/verify-a-copy) says what the answer card means and what does not match.
- [Explore the registry](../guides/explore) is every passport on Monad in one grid, with the filters
  over it.
- [How it works](../concepts/how-it-works) is the life of one passport end to end.
