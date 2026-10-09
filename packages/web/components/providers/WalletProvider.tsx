"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { isPrivyConfigured } from "@/lib/env";

type Wrapper = ComponentType<{ children: ReactNode }>;

/**
 * Whether the wallet SDK's own provider is above this point in the tree.
 *
 * Exported so a test can put a screen under a mounted wallet without a
 * browser. Nothing else should set it: WalletHost and WalletProvider are the
 * only places that know when the SDK has actually arrived.
 */
export const WalletMounted = createContext(false);

/** True only while Privy's provider is mounted, so a screen knows its hooks are safe to call. */
export function useWalletMounted(): boolean {
  return useContext(WalletMounted);
}

/**
 * The mark SessionMark writes on a device that has signed in to Moolam, and
 * the only thing a "returning" page looks at before it fetches the SDK.
 */
export const RETURNING_KEY = "moolam:wallet:returning";

/** Whether this browser has signed in here before. A browser that refuses storage counts as new. */
function signedInBefore(): boolean {
  try {
    return window.localStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
}

type Load = "always" | "returning";
type Loaded = { Provider: Wrapper; Mark: ComponentType };

/**
 * Fetches both halves of the wallet SDK. They come down the same dynamic path:
 * SessionMark imports the SDK directly, so naming it anywhere a bundler reads
 * statically would put the wallet back into the page's own scripts.
 */
function fetchWallet(): Promise<Loaded> {
  return Promise.all([import("./PrivyProvider"), import("./SessionMark")]).then(([provider, mark]) => ({
    Provider: provider.PrivyProvider,
    Mark: mark.SessionMark,
  }));
}

/** What WalletHost hands down: a way for a page to ask for the wallet. */
const WalletHostContext = createContext<{ request: (load: Load) => void } | null>(null);

/**
 * Keeps the wallet mounted while a person moves around the site.
 *
 * The engine is about half a megabyte, so it still loads only when a page that
 * signs asks for it (or a passport asks, for someone who has signed in before).
 * What changed is what happens next: the layout holds it mounted afterwards, so
 * going from the studio to a passport and back no longer starts it again and
 * re-checks the sign-in each time. A reader who never reaches a signing page
 * never fetches it, because nothing loads until a WalletProvider below calls
 * request.
 *
 * request is called from an effect, never during render, so the server and the
 * first client paint stay identical. The load happens at most once while this
 * host stays mounted, and nothing loads without an app id.
 */
export function WalletHost({ children }: { children: ReactNode }) {
  const [privy, setPrivy] = useState<Loaded | null>(null);
  const started = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const request = useCallback((load: Load) => {
    if (started.current || !isPrivyConfigured || (load === "returning" && !signedInBefore())) {
      return;
    }

    started.current = true;
    fetchWallet().then(
      (loaded) => {
        if (live.current) {
          setPrivy(loaded);
        }
      },
      () => {
        // A chunk that did not arrive is asked for again by the next page that signs.
        started.current = false;
      },
    );
  }, []);

  const host = useMemo(() => ({ request }), [request]);

  if (privy === null) {
    return <WalletHostContext.Provider value={host}>{children}</WalletHostContext.Provider>;
  }

  const Provider = privy.Provider;
  const Mark = privy.Mark;
  return (
    <WalletHostContext.Provider value={host}>
      <Provider>
        <Mark />
        <WalletMounted.Provider value={true}>{children}</WalletMounted.Provider>
      </Provider>
    </WalletHostContext.Provider>
  );
}

/**
 * Asks for the wallet on the three routes that sign and nowhere else.
 *
 * Privy brings wagmi, viem and the noble libraries with it, about half a
 * megabyte that a reader of the home page, the docs or an agent will never
 * use, so the provider is no longer in the layout every route shares. It is
 * asked for here, by the pages that need it. Under the layout's WalletHost this
 * only makes the request, and the host keeps the engine mounted after the page
 * is gone, so the next signing page finds it already running. With no host
 * above it (a test, or any tree outside the layout) it loads the engine itself
 * and wraps its own children, as it did before the host existed.
 *
 * The children render before it arrives and again once it is up, because the
 * passport page passes server rendered content through here. Privy's hooks do
 * not survive that first pass: called without their context they print a
 * warning on every render and answer ready false. So the screens under this
 * provider read useWalletMounted and paint their waiting state until it is
 * true, and only then call a hook. Without an app id nothing is fetched at all.
 *
 * load says who gets the SDK. "always" is the studio and the resolve console,
 * where signing in is the point of the page. "returning" is a passport, where
 * the two writing panels show nothing to a signed out visitor: a reader who has
 * never signed in on this device pays nothing for panels they cannot see, and a
 * creator who has gets them as before. The check runs inside the effect, never
 * during render, so the server and the first client paint stay identical on
 * every device.
 */
export function WalletProvider({ children, load = "always" }: { children: ReactNode; load?: Load }) {
  const host = useContext(WalletHostContext);
  const [privy, setPrivy] = useState<Loaded | null>(null);

  useEffect(() => {
    if (host !== null) {
      host.request(load);
      return;
    }

    if (!isPrivyConfigured || (load === "returning" && !signedInBefore())) {
      return;
    }

    let live = true;
    void fetchWallet().then((loaded) => {
      if (live) {
        setPrivy(loaded);
      }
    });

    return () => {
      live = false;
    };
  }, [host, load]);

  if (host !== null || privy === null) {
    return children;
  }

  const Provider = privy.Provider;
  const Mark = privy.Mark;
  return (
    <Provider>
      <Mark />
      <WalletMounted.Provider value={true}>{children}</WalletMounted.Provider>
    </Provider>
  );
}
