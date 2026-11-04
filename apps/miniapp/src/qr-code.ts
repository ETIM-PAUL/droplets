import { encode } from "uqr";

/**
 * The modules of a QR code for `text`, with the 4-module quiet zone scanners need.
 * Medium error correction: a save code still scans from a slightly scratched or glare-washed screen.
 */
export function qrModules(text: string): { size: number; dark: boolean[][] } {
  const qr = encode(text, { ecc: "M", border: 4 });
  return { size: qr.size, dark: qr.data };
}

/** One SVG path for every dark module, merging runs along each row so the path stays short. */
export function qrPath(dark: boolean[][]): string {
  let d = "";
  dark.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return d;
}
