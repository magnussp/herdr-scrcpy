// Synthetic Kitty-graphics load for measuring the terminal/herdr side without a
// phone: bun src/bench.ts <width> <height> <fps> <seconds> [file|direct]
// Draws frames that change every time (so no layer can dedup them) through the
// same single-id RGBA path the mirror uses inside herdr.
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./config";
import { createFrameDir } from "./files";
import { kittyFileFrame, kittyFrame, term } from "./terminal";

const [w, h, fps, seconds] = process.argv.slice(2, 6).map(Number);

// 5x7 bitmap font for the timestamp (digits, ':' and '.').
const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
};
/** Draws `text` in black on a white box at (x0, y0), `k` px per font pixel. */
function drawText(buf: Buffer, text: string, x0: number, y0: number, k: number) {
  const bw = text.length * 6 * k + k, bh = 9 * k;
  for (let y = y0; y < Math.min(h, y0 + bh); y++) buf.fill(255, (y * w + x0) * 4, (y * w + Math.min(w, x0 + bw)) * 4);
  [...text].forEach((ch, i) => {
    FONT[ch]?.forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) {
        if (row[rx] !== "1") continue;
        for (let dy = 0; dy < k; dy++) {
          const y = y0 + k + ry * k + dy;
          const x = x0 + k + (i * 6 + rx) * k;
          if (y < h && x + k <= w) for (let dx = 0; dx < k; dx++) buf.writeUInt32BE(0x000000ff, (y * w + x + dx) * 4);
        }
      }
    });
  });
}
const stamp = () => {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
const mode = process.argv[6] === "direct" ? "direct" : "file";
const logPath = process.env.BENCH_LOG ?? join(stateDir(), "bench.log");
const out = process.stdout;
const frame = Buffer.alloc(w * h * 4, 255);
const rows = Math.max(1, (out.rows || 24) - 1);
const cols = Math.min(out.columns || 80, Math.round((rows * 2 * w) / h));

const frameDir = createFrameDir();
out.write(term.enter);
let n = 0, written = 0;
const t0 = performance.now();
const timer = setInterval(() => {
  // Shift a coloured band every frame so each frame's content is unique.
  const band = (n * 16) % h;
  frame.fill(n & 1 ? 40 : 200);
  frame.fill((n * 37) & 255, band * w * 4, Math.min(h, band + 64) * w * 4);
  drawText(frame, stamp(), 8, Math.floor(h / 3), Math.max(2, Math.floor(w / 60)));
  const opts = { id: 7031, cols, rows };
  let s: string;
  if (mode === "file") {
    const p = join(frameDir, `tty-graphics-protocol-${n}.rgba`);
    writeFileSync(p, frame, { flag: "wx" });
    s = kittyFileFrame(p, w, h, opts);
  } else {
    s = kittyFrame(frame, w, h, opts);
  }
  written += s.length;
  out.write(term.moveTo(0, 0) + s);
  n++;
  if (performance.now() - t0 > seconds * 1000) {
    clearInterval(timer);
    appendFileSync(logPath, `${w}x${h} ${fps}fps ${mode}: sent ${n} frames, ${(written / 1024).toFixed(0)} KB to pty\n`);
    rmSync(frameDir, { recursive: true, force: true });
    out.write(term.deleteImage(7031) + term.leave, () => process.exit(0));
  }
}, 1000 / fps);
