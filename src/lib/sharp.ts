import sharp from 'sharp';

/**
 * Keep the import statically traceable. `serverExternalPackages` leaves Sharp
 * as a Node dependency, while Next's output tracer copies its native runtime
 * into the serverless function. A computed createRequire() call is compiled
 * into a permanent MODULE_NOT_FOUND throw by Turbopack.
 */
export function getSharp(): typeof sharp {
  return sharp;
}
