import { describe, expect, it } from "vitest";
import { parseNimiqAddress } from "./nimiq-address";

describe("parseNimiqAddress", () => {
  it("accepts the burn address and normalises spacing and case", () => {
    expect(parseNimiqAddress("nq07 0000 0000 0000 0000 0000 0000 0000 0000")).toEqual({ ok: true, value: "NQ07 0000 0000 0000 0000 0000 0000 0000 0000" });
    expect(parseNimiqAddress("NQ0700000000000000000000000000000000").ok).toBe(true);
  });

  it("catches a typo through the checksum", () => {
    const r = parseNimiqAddress("NQ08 0000 0000 0000 0000 0000 0000 0000 0000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/typo/);
  });

  it("refuses other formats and characters Nimiq never uses", () => {
    expect(parseNimiqAddress("0x52908400098527886E0F7030069857D2E4169EE7").ok).toBe(false);
    expect(parseNimiqAddress("NQ07 0000 0000 0000 0000 0000 0000 0000 000O").ok).toBe(false);
  });
});
