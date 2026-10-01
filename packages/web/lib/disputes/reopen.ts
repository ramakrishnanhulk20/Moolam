import type { Hex } from "viem";

/**
 * Where the open challenge panel is remembered across the one reload a first
 * sign-in makes on a passport page. A device that never signed in has no
 * wallet mounted, so pressing Sign in to challenge brings one for the length
 * of the sign-in and reloads the page with the wallet up (OwnerHintWallet). The
 * panel then opens itself again, so the form lands where the press was.
 */
const REOPEN_KEY = "moolam:challenge:reopen";

export function rememberReopen(passportId: Hex): void {
  try {
    window.sessionStorage.setItem(REOPEN_KEY, passportId.toLowerCase());
  } catch {
    // Storage that refuses costs one more press on the toggle after the reload.
  }
}

/** True once per remembered passport: the mark is taken as it is read. */
export function takeReopen(passportId: Hex): boolean {
  try {
    if (window.sessionStorage.getItem(REOPEN_KEY) !== passportId.toLowerCase()) {
      return false;
    }
    window.sessionStorage.removeItem(REOPEN_KEY);
    return true;
  } catch {
    return false;
  }
}
