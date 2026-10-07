import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { InputParser, kittyFileFrame, kittyFrame, type InputEvent } from "../src/terminal";

function parse(...chunks: string[]): InputEvent[] {
  const events: InputEvent[] = [];
  const p = new InputParser((e) => events.push(e));
  for (const c of chunks) p.feed(Buffer.from(c, "utf8"));
  return events;
}

describe("InputParser", () => {
  test("SGR mouse press, drag, release and wheel", () => {
    expect(parse("\x1b[<0;10;5M", "\x1b[<32;11;6M", "\x1b[<0;11;6m", "\x1b[<64;1;1M")).toEqual([
      { type: "mouse", button: 0, mods: 0, x: 10, y: 5, press: true, motion: false },
      { type: "mouse", button: 0, mods: 0, x: 11, y: 6, press: true, motion: true },
      { type: "mouse", button: 0, mods: 0, x: 11, y: 6, press: false, motion: false },
      { type: "mouse", button: 64, mods: 0, x: 1, y: 1, press: true, motion: false },
    ]);
  });

  test("sequences split across reads", () => {
    expect(parse("\x1b[<0;1", ";2M")).toEqual([
      { type: "mouse", button: 0, mods: 0, x: 1, y: 2, press: true, motion: false },
    ]);
  });

  test("keys, control characters and text", () => {
    expect(parse("\x1b[A\x1b[3~\x1b[5~\r\x7f\x11héllo")).toEqual([
      { type: "key", name: "up" },
      { type: "key", name: "delete" },
      { type: "key", name: "pageup" },
      { type: "key", name: "enter" },
      { type: "key", name: "backspace" },
      { type: "ctrl", char: "q" },
      { type: "text", text: "héllo" },
    ]);
  });

  test("terminal replies", () => {
    expect(parse("\x1b_Gi=34;OK\x1b\\", "\x1b[6;20;10t")).toEqual([
      { type: "kitty", payload: "Gi=34;OK" },
      { type: "reply", kind: "cellPx", h: 20, w: 10 },
    ]);
  });

  test("a lone ESC becomes the Escape key after a short pause", async () => {
    const events = parse("\x1b");
    expect(events).toEqual([]);
    await Bun.sleep(60);
    expect(events).toEqual([{ type: "key", name: "escape" }]);
  });
});

describe("Kitty graphics commands", () => {
  const opts = { id: 7031, cols: 40, rows: 60 };

  test("temp-file frame carries only the path", () => {
    const s = kittyFileFrame("/tmp/x/tty-graphics-protocol-1.rgba", 572, 1280, opts);
    expect(s.startsWith("\x1b_Ga=T,t=t,f=32,s=572,v=1280,i=7031,p=1,c=40,r=60,C=1,q=2;")).toBe(true);
    expect(s.endsWith("\x1b\\")).toBe(true);
    const payload = s.slice(s.indexOf(";") + 1, -2);
    expect(Buffer.from(payload, "base64").toString()).toBe("/tmp/x/tty-graphics-protocol-1.rgba");
  });

  test("inline frame is chunked zlib+base64 that round-trips", () => {
    const rgba = Buffer.alloc(64 * 64 * 4);
    let seed = 1; // pseudo-random bytes so zlib can't shrink them into a single chunk
    for (let i = 0; i < rgba.length; i++) rgba[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    const s = kittyFrame(rgba, 64, 64, opts);
    const chunks = s.split("\x1b\\").filter(Boolean).map((c) => c.slice(3)); // drop "\x1b_G"
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith("a=T,f=32,o=z,s=64,v=64,i=7031")).toBe(true);
    expect(chunks[0]).toContain("m=1;");
    expect(chunks[chunks.length - 1].startsWith("m=0;")).toBe(true);
    const b64 = chunks.map((c) => c.slice(c.indexOf(";") + 1)).join("");
    expect(inflateSync(Buffer.from(b64, "base64")).equals(rgba)).toBe(true);
  });
});
