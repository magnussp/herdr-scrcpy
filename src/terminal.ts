// Terminal I/O: raw mode, capability queries, Kitty graphics output and an
// input parser for keys, SGR mouse reports and query responses.
import { deflateSync } from "node:zlib";

const ESC = "\x1b";
const APC_END = `${ESC}\\`;

export type InputEvent =
  | { type: "mouse"; button: number; x: number; y: number; press: boolean; motion: boolean; mods: number }
  | { type: "key"; name: string }
  | { type: "text"; text: string }
  | { type: "ctrl"; char: string } // ctrl+<letter>, lowercase
  | { type: "reply"; kind: "textAreaPx" | "cellPx"; w: number; h: number }
  | { type: "kitty"; payload: string };

const CSI_KEYS: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
  "3~": "delete", "5~": "pageup", "6~": "pagedown", "1~": "home", "4~": "end",
};

/** Splits raw stdin bytes into events. Keeps state for sequences split across reads. */
export class InputParser {
  private pending = "";
  private escTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private emit: (e: InputEvent) => void) {}

  feed(chunk: Buffer) {
    const s = chunk.toString("latin1");
    if (this.escTimer) clearTimeout(this.escTimer);
    this.pending += s;
    this.parse();
    // A lone ESC (no follow-up within 30ms) is the Escape key.
    if (this.pending === ESC) {
      this.escTimer = setTimeout(() => {
        if (this.pending === ESC) {
          this.pending = "";
          this.emit({ type: "key", name: "escape" });
        }
      }, 30);
    }
  }

  private parse() {
    let text = "";
    const flushText = () => {
      if (text) this.emit({ type: "text", text: Buffer.from(text, "latin1").toString("utf8") });
      text = "";
    };
    let s = this.pending;
    while (s.length) {
      const c = s.charCodeAt(0);
      if (c === 0x1b) {
        if (s.length === 1) break; // maybe incomplete
        let m: RegExpMatchArray | null;
        if (s[1] === "[") {
          if ((m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/))) {
            flushText();
            const b = Number(m[1]);
            this.emit({
              type: "mouse", button: b & 0b11000011, mods: b & 0b11100,
              x: Number(m[2]), y: Number(m[3]), press: m[4] === "M", motion: (b & 32) !== 0,
            });
          } else if ((m = s.match(/^\x1b\[(4|6);(\d+);(\d+)t/))) {
            flushText();
            this.emit({ type: "reply", kind: m[1] === "4" ? "textAreaPx" : "cellPx", h: Number(m[2]), w: Number(m[3]) });
          } else if ((m = s.match(/^\x1b\[([0-9;]*)([A-Za-z~])/))) {
            flushText();
            const key = m[2] === "~" ? `${m[1].split(";")[0]}~` : m[2];
            this.emit({ type: "key", name: CSI_KEYS[key] ?? `csi:${m[1]}${m[2]}` });
          } else if (/^\x1b\[[0-9;<]*$/.test(s)) {
            break; // incomplete CSI
          } else {
            s = s.slice(2);
            continue;
          }
          s = s.slice(m[0].length);
        } else if (s[1] === "_") {
          const end = s.indexOf(APC_END);
          if (end < 0) break; // incomplete APC
          flushText();
          this.emit({ type: "kitty", payload: s.slice(2, end) });
          s = s.slice(end + 2);
        } else if (s[1] === "O" && s.length >= 3) {
          flushText();
          this.emit({ type: "key", name: CSI_KEYS[s[2]] ?? `ss3:${s[2]}` });
          s = s.slice(3);
        } else {
          // alt+key: treat as plain key
          s = s.slice(1);
        }
        continue;
      }
      if (c === 0x0d || c === 0x0a) { flushText(); this.emit({ type: "key", name: "enter" }); }
      else if (c === 0x09) { flushText(); this.emit({ type: "key", name: "tab" }); }
      else if (c === 0x7f || c === 0x08) { flushText(); this.emit({ type: "key", name: "backspace" }); }
      else if (c < 0x20) { flushText(); this.emit({ type: "ctrl", char: String.fromCharCode(c + 0x60) }); }
      else text += s[0];
      s = s.slice(1);
    }
    flushText();
    this.pending = s;
  }
}

export const term = {
  enter: `${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`,
  leave: `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`,
  /** Ask for text-area pixel size, cell pixel size, and Kitty graphics support. */
  queries: `${ESC}[14t${ESC}[16t${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${APC_END}`,
  moveTo: (row: number, col: number) => `${ESC}[${row + 1};${col + 1}H`,
  clearLine: `${ESC}[2K`,
  clear: `${ESC}[2J`,
  deleteImage: (id: number) => `${ESC}_Ga=d,d=I,i=${id},q=2${APC_END}`,
};

const CHUNK = 4096;

/** Encodes an RGBA frame as an inline (zlib+base64) Kitty transmit+display command. */
export function kittyFrame(
  rgba: Buffer, width: number, height: number,
  opts: { id: number; cols: number; rows: number },
): string {
  const b64 = deflateSync(rgba, { level: 1 }).toString("base64");
  const head = `a=T,f=32,o=z,s=${width},v=${height},i=${opts.id},p=1,c=${opts.cols},r=${opts.rows},C=1,q=2`;
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    const more = i + CHUNK < b64.length ? 1 : 0;
    const keys = i === 0 ? `${head},m=${more}` : `m=${more}`;
    parts.push(`${ESC}_G${keys};${b64.slice(i, i + CHUNK)}${APC_END}`);
  }
  return parts.join("");
}

/** Kitty command that makes the terminal read a raw RGBA frame from a temp file (t=t). */
export function kittyFileFrame(
  path: string, width: number, height: number,
  opts: { id: number; cols: number; rows: number },
): string {
  const keys = `a=T,t=t,f=32,s=${width},v=${height},i=${opts.id},p=1,c=${opts.cols},r=${opts.rows},C=1,q=2`;
  return `${ESC}_G${keys};${Buffer.from(path).toString("base64")}${APC_END}`;
}
