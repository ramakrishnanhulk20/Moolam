// A hand-written stand-in for the types `envio codegen` will emit. It exists only
// because codegen needs Linux and WSL2 is still being installed on this machine,
// so the handlers below it had nothing to type-check against.
//
// DELETE THIS FILE THE FIRST TIME `envio codegen` RUNS.
// Measured, not assumed: an ambient `declare module "envio"` wins over the real
// package in node_modules and hides every export it does not list. A throwaway
// project with both present failed with
//   error TS2305: Module '"envio"' has no exported member 'createTestIndexer'.
// as soon as the code touched an export only the real package declares. Codegen
// does not shadow this file; this file shadows codegen. The evidence and the
// commands are in kitchen/reports/WO-3b-notes.txt section 5.
//
// Every shape here is copied from envio 3.9.0's own package/index.d.ts (line
// numbers in the notes file) and from
// https://docs.envio.dev/docs/HyperIndex/event-handlers.md
// https://docs.envio.dev/docs/HyperIndex/testing.md
// The entity shapes come from schema.graphql, with each relation field stored as
// `<field>_id` the way the schema page says relations are written.

declare module "envio" {
  export type Address = `0x${string}`;

  export type Logger = {
    readonly debug: (message: string, params?: Record<string, unknown> | Error) => void;
    readonly info: (message: string, params?: Record<string, unknown> | Error) => void;
    readonly warn: (message: string, params?: Record<string, unknown> | Error) => void;
    readonly error: (message: string, params?: Record<string, unknown> | Error) => void;
  };

  export type Passport = {
    readonly id: string;
    readonly creator_id: string;
    readonly parent_id: string | undefined;
    readonly root_id: string;
    readonly depth: number;
    readonly generator_id: string | undefined;
    readonly kind: number;
    readonly phash: bigint;
    readonly blockhash: string;
    readonly manifestHash: string;
    readonly fingerprintVersion: number;
    readonly metadataURI: string;
    readonly owner: string;
    readonly registeredAt: bigint;
    readonly registeredBlock: bigint;
    readonly txHash: string;
    readonly disputed: boolean;
    readonly attestationCount: number;
    readonly matchedCount: number;
    readonly mismatchedCount: number;
    readonly dispute_id: string | undefined;
  };

  export type Creator = {
    readonly id: string;
    readonly passportCount: number;
    readonly editCount: number;
    readonly passkey_id: string | undefined;
    readonly firstSeenAt: bigint;
  };

  export type Passkey = {
    readonly id: string;
    readonly qx: string;
    readonly qy: string;
    readonly nonce: bigint;
    readonly boundAt: bigint;
  };

  export type Generator = {
    readonly id: string;
    readonly passportCount: number;
    readonly matchedCount: number;
    readonly mismatchedCount: number;
    readonly disputesUpheld: number;
    readonly trustScore: number;
    readonly firstSeenAt: bigint;
  };

  export type Attestation = {
    readonly id: string;
    readonly passport_id: string;
    readonly receiver: string;
    readonly matched: boolean;
    readonly distance: number;
    readonly recomputed: string;
    readonly at: bigint;
  };

  export type Dispute = {
    readonly id: string;
    readonly passport_id: string;
    readonly challenger: string;
    readonly bond: bigint;
    readonly evidenceHash: string;
    readonly evidenceURI: string;
    readonly status: number;
    readonly openedAt: bigint;
    readonly resolvedAt: bigint | undefined;
    readonly resolver: string | undefined;
  };

  export type Receiver = {
    readonly id: string;
    readonly active: boolean;
    readonly since: bigint;
  };

  export type DailyStats = {
    readonly id: string;
    readonly registrations: number;
    readonly edits: number;
    readonly attestations: number;
    readonly disputes: number;
    readonly uniqueCreators: number;
  };

  export type GlobalStats = {
    readonly id: string;
    readonly passports: number;
    readonly creators: number;
    readonly generators: number;
    readonly attestations: number;
    readonly disputes: number;
  };

  type Entities = {
    Passport: Passport;
    Creator: Creator;
    Passkey: Passkey;
    Generator: Generator;
    Attestation: Attestation;
    Dispute: Dispute;
    Receiver: Receiver;
    DailyStats: DailyStats;
    GlobalStats: GlobalStats;
  };

  export type EntityName = keyof Entities;
  export type Entity<TName extends EntityName> = Entities[TName];

  type GetWhereOperator<T> = {
    readonly _eq?: T;
    readonly _gt?: T;
    readonly _gte?: T;
    readonly _lt?: T;
    readonly _lte?: T;
    readonly _in?: readonly T[];
  };

  type GetWhereFilter<E> = { readonly [K in keyof E]?: GetWhereOperator<E[K]> };

  // `set` returns void on purpose: writes go through an in-memory store, so the
  // docs say not to await them.
  type EntityOperations<E> = {
    readonly get: (id: string) => Promise<E | undefined>;
    readonly getOrThrow: (id: string, message?: string) => Promise<E>;
    readonly getWhere: (filter: GetWhereFilter<E>) => Promise<E[]>;
    readonly getOrCreate: (entity: E) => Promise<E>;
    readonly set: (entity: E) => void;
    readonly deleteUnsafe: (id: string) => void;
  };

  export type HandlerContext = {
    readonly log: Logger;
    readonly isPreload: boolean;
    readonly chain: { readonly id: 143; readonly isRealtime: boolean };
  } & { readonly [K in EntityName]: EntityOperations<Entities[K]> };

  // number, timestamp and hash are always present on the block. Everything else
  // needs field_selection in config.yaml, which asks only for transaction.hash.
  type EvmBlock = {
    readonly number: number;
    readonly timestamp: number;
    readonly hash: string;
  };

  type EvmTransaction = { readonly hash: string };

  type EvmEventOf<Params> = {
    readonly params: Params;
    readonly chainId: 143;
    readonly srcAddress: Address;
    readonly logIndex: number;
    readonly block: EvmBlock;
    readonly transaction: EvmTransaction;
  };

  // Solidity to TypeScript exactly as envio's own decoder maps it: every uintN
  // and intN is a bigint, every bytesN is a 0x hex string, address is checksummed.
  type MoolamRegistryEvents = {
    PasskeyBound: {
      readonly wallet: Address;
      readonly qx: string;
      readonly qy: string;
      readonly nonce: bigint;
    };
    PassportRegistered: {
      readonly passportId: string;
      readonly creator: Address;
      readonly generatorAgentId: bigint;
      readonly parentId: string;
      readonly phash: bigint;
      readonly blockhash256: string;
      readonly manifestHash: string;
      readonly kind: bigint;
      readonly fingerprintVersion: bigint;
      readonly metadataURI: string;
    };
    VerificationAttested: {
      readonly passportId: string;
      readonly receiver: Address;
      readonly matched: boolean;
      readonly distance: bigint;
      readonly recomputed: string;
    };
    PassportFlagged: {
      readonly passportId: string;
      readonly challenger: Address;
      readonly bond: bigint;
      readonly evidenceHash: string;
      readonly evidenceURI: string;
    };
    DisputeResolved: {
      readonly passportId: string;
      readonly upheld: boolean;
      readonly resolver: Address;
    };
    Transfer: {
      readonly from: Address;
      readonly to: Address;
      readonly tokenId: bigint;
    };
  };

  type VerifierPolicyEvents = {
    ReceiverAdded: { readonly receiver: Address };
    ReceiverRemoved: { readonly receiver: Address };
  };

  type Contracts = {
    MoolamRegistry: MoolamRegistryEvents;
    VerifierPolicy: VerifierPolicyEvents;
  };

  export const indexer: {
    readonly onEvent: <
      C extends keyof Contracts,
      E extends keyof Contracts[C] & string,
    >(
      options: { readonly contract: C; readonly event: E; readonly wildcard?: boolean },
      handler: (args: {
        event: EvmEventOf<Contracts[C][E]>;
        context: HandlerContext;
      }) => Promise<void>,
    ) => void;
  };

  type SimulateItem = {
    [C in keyof Contracts]: {
      [E in keyof Contracts[C]]: {
        readonly contract: C;
        readonly event: E;
        readonly srcAddress?: Address;
        readonly logIndex?: number;
        readonly block?: Partial<EvmBlock>;
        readonly transaction?: Partial<EvmTransaction>;
        readonly params?: Partial<Contracts[C][E]>;
      };
    }[keyof Contracts[C]];
  }[keyof Contracts];

  type EntityChange = {
    readonly block: number;
    readonly chainId: number;
    readonly eventsProcessed: number;
  } & {
    readonly [K in EntityName]?: {
      readonly sets?: readonly Entities[K][];
      readonly deleted?: readonly string[];
    };
  };

  type TestEntityOperations<E> = {
    readonly get: (id: string) => Promise<E | undefined>;
    readonly getOrThrow: (id: string, message?: string) => Promise<E>;
    readonly getAll: () => Promise<E[]>;
    readonly getWhere: (filter: GetWhereFilter<E>) => Promise<E[]>;
    readonly set: (entity: E) => void;
  };

  export type TestIndexer = {
    readonly process: (config: {
      readonly chains: {
        readonly 143?: {
          readonly startBlock?: number;
          readonly endBlock?: number;
          readonly simulate?: readonly SimulateItem[];
        };
      };
    }) => Promise<{ readonly changes: readonly EntityChange[] }>;
  } & { readonly [K in EntityName]: TestEntityOperations<Entities[K]> };

  export const createTestIndexer: () => TestIndexer;

  export const TestHelpers: {
    readonly Addresses: {
      readonly mockAddresses: readonly Address[];
      readonly defaultAddress: Address;
    };
  };
}
