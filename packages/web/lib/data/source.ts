import { publicEnv } from "@/lib/env";

/**
 * Which index answers "show me the newest passports".
 *
 * Envio Cloud is the production answer and takes over the moment its URL is
 * set. Until then the app reads the registry's own events straight from Monad,
 * which is slower but is the same truth, and the footer says which one ran so
 * nobody has to guess.
 */
export type DataSource = "envio" | "chain";

export function activeSource(): DataSource {
  return publicEnv.envioGraphqlUrl === undefined ? "chain" : "envio";
}

export function envioUrl(): string {
  if (publicEnv.envioGraphqlUrl === undefined) {
    throw new Error("NEXT_PUBLIC_ENVIO_GRAPHQL_URL is not set");
  }
  return publicEnv.envioGraphqlUrl;
}
