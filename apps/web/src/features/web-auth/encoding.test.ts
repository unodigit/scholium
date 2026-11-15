import { describe, expect, it } from "vitest";

import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  toUint8Array,
  utf8Decode,
  utf8Encode,
} from "./encoding";
import { DeviceKeyError } from "./errors";

function errorFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

function expectCode(run: () => unknown, code: string): void {
  const error = errorFrom(run);
  expect(error).toBeInstanceOf(DeviceKeyError);
  expect((error as DeviceKeyError).code).toBe(code);
}

describe("toUint8Array", () => {
  it("passes an ArrayBuffer-backed Uint8Array through", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    expect(toUint8Array(bytes)).toBe(bytes);
  });

  it("copies the visible window of an offset view", () => {
    const backing = Uint8Array.of(9, 1, 2, 3, 9);
    const view = new DataView(backing.buffer, 1, 3);
    expect([...toUint8Array(view)]).toEqual([1, 2, 3]);
  });

  it("wraps an ArrayBuffer", () => {
    const buffer = Uint8Array.of(4, 5, 6).buffer;
    expect([...toUint8Array(buffer)]).toEqual([4, 5, 6]);
  });

  it("rejects non-binary input", () => {
    expect(() => toUint8Array("nope" as unknown as ArrayBuffer)).toThrow(
      DeviceKeyError,
    );
  });
});

describe("bytesEqual / concatBytes", () => {
  it("compares content, not identity", () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
  });

  it("concatenates in order", () => {
    expect([
      ...concatBytes(Uint8Array.of(1), Uint8Array.of(2, 3), new Uint8Array(0)),
    ]).toEqual([1, 2, 3]);
  });
});

describe("hex", () => {
  it("round-trips", () => {
    const bytes = Uint8Array.of(0x00, 0x0f, 0x10, 0xff);
    expect(toHex(bytes)).toBe("000f10ff");
    expect([...fromHex("000F10FF")]).toEqual([...bytes]);
  });

  it("rejects odd length and non-hex characters", () => {
    expectCode(() => fromHex("abc"), "invalid-encoding");
    expectCode(() => fromHex("zz"), "invalid-encoding");
  });
});

describe("base64url", () => {
  it("encodes known vectors without padding", () => {
    expect(toBase64Url(utf8Encode("hello"))).toBe("aGVsbG8");
    expect(toBase64Url(Uint8Array.of(0xff, 0xff))).toBe("__8");
    expect(toBase64Url(new Uint8Array(0))).toBe("");
  });

  it("round-trips every length from 0 to 32 bytes", () => {
    for (let length = 0; length <= 32; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        bytes[i] = (i * 37 + 11) & 0xff;
      }
      expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
    }
  });

  it("accepts padded and standard base64", () => {
    expect([...fromBase64Url("//8=")]).toEqual([255, 255]);
  });

  it("rejects invalid characters and impossible lengths", () => {
    expectCode(() => fromBase64Url("ab$c"), "invalid-encoding");
    expectCode(() => fromBase64Url("a"), "invalid-encoding");
  });
});

describe("utf8", () => {
  it("round-trips multi-byte text", () => {
    const text = "Scholium — did:key:z6Mk";
    expect(utf8Decode(utf8Encode(text))).toBe(text);
  });
});
