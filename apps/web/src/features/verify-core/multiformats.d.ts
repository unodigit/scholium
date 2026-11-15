/**
 * Minimal typings for the `multiformats` v9 subpath imports used by
 * verify-core.
 *
 * `multiformats@9.9.0` ships its declarations under `types/` but its
 * `package.json` `exports` map does not expose a `types` condition, so
 * TypeScript with `moduleResolution: "bundler"` cannot resolve them.  The
 * declarations below cover exactly the surface this feature uses; they are
 * structural, not a fork of the upstream types.
 */

declare module "multiformats/cid" {
  export interface MultihashDigest {
    readonly code: number;
    readonly size: number;
    readonly digest: Uint8Array;
    readonly bytes: Uint8Array;
  }

  export class CID {
    readonly version: number;
    readonly code: number;
    readonly multihash: MultihashDigest;
    readonly bytes: Uint8Array;
    toString(base?: unknown): string;
    static parse(value: string, base?: unknown): CID;
    static decode(bytes: Uint8Array): CID;
    static create(
      version: number,
      code: number,
      digest: MultihashDigest,
    ): CID;
  }
}

declare module "multiformats/hashes/digest" {
  export function create(
    code: number,
    digest: Uint8Array,
  ): {
    readonly code: number;
    readonly size: number;
    readonly digest: Uint8Array;
    readonly bytes: Uint8Array;
  };
}

declare module "multiformats/bases/base32" {
  export const base32: {
    readonly prefix: string;
    encode(bytes: Uint8Array): string;
    decode(value: string): Uint8Array;
  };
}

declare module "multiformats/bases/base58" {
  export const base58btc: {
    readonly prefix: string;
    encode(bytes: Uint8Array): string;
    decode(value: string): Uint8Array;
  };
}

declare module "multiformats/basics" {
  export const bases: Record<
    string,
    {
      readonly prefix: string;
      encode(bytes: Uint8Array): string;
      decode(value: string): Uint8Array;
    }
  >;
}
