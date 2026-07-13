import { createRequire } from 'node:module';

type SharpModule = typeof import('sharp');

const runtimeRequire = createRequire(import.meta.url);
let sharpModule: SharpModule | null = null;

/** Load Sharp at runtime so native optional binaries are never web-bundled. */
export function getSharp(): SharpModule {
  if (!sharpModule) {
    sharpModule = runtimeRequire(['sh', 'arp'].join('')) as SharpModule;
  }
  return sharpModule;
}
