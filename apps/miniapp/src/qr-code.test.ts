import { formatSaveCode, newSaveCode } from "@railkit/core";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { qrModules, qrPath } from "./qr-code";

/** Paints the modules black on white, `scale` pixels each, the way the SVG draws them. */
function bitmap(dark: boolean[][], scale: number) {
  const n = dark.length * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  dark.forEach((row, y) =>
    row.forEach((on, x) => {
      if (!on) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * n + (x * scale + dx)) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }),
  );
  return { px, n };
}

describe("save code QR", () => {
  it("scans back to exactly the save code", () => {
    for (let i = 0; i < 20; i++) {
      const code = formatSaveCode(newSaveCode());
      const { dark, size } = qrModules(code);
      expect(dark).toHaveLength(size);
      const { px, n } = bitmap(dark, 4);
      expect(jsQR(px, n, n)?.data).toBe(code);
    }
  });

  it("keeps the 4-module quiet zone white", () => {
    const { dark, size } = qrModules("SAVE-7KQ2XMP");
    for (let i = 0; i < size; i++) {
      for (const k of [0, 1, 2, 3, size - 1, size - 2, size - 3, size - 4]) {
        expect(dark[k]![i]).toBe(false);
        expect(dark[i]![k]).toBe(false);
      }
    }
  });

  it("draws one path segment per run of dark modules", () => {
    expect(qrPath([[false, true, true, false, true]])).toBe("M1 0h2v1h-2zM4 0h1v1h-1z");
    expect(qrPath([[false, false]])).toBe("");
  });
});
