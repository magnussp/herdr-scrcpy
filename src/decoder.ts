// H.264 -> RGBA via the native helper (native/decode.c). It feeds scrcpy's
// complete-frame packets straight into libavcodec in low-delay mode, so each
// frame comes out as soon as its packet goes in, and writes every frame to its
// own raw file so the pixels never pass through a pipe or the JS heap. It also
// follows resolution changes (rotation), so one decoder lives for the whole
// connection.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { stateDir } from "./config";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "native", "decode.c");
const BUILD_SCRIPT = join(ROOT, "scripts", "build-native.sh");
/** Built by the manifest's [[build]] step (or by hand in a linked checkout). */
const INSTALLED_BIN = join(ROOT, "bin", "scrcpy-decode");

const isFresh = (bin: string) => existsSync(bin) && statSync(bin).mtimeMs >= statSync(SRC).mtimeMs;

/**
 * Path of an up-to-date decoder binary. Prefers the one built at install time;
 * otherwise (linked checkout without a build, or edited decode.c) builds one
 * into the plugin's state directory, never into the plugin directory itself,
 * which herdr manages for installed plugins.
 */
export function decoderBinary(log: (m: string) => void): string {
  if (isFresh(INSTALLED_BIN)) return INSTALLED_BIN;
  const fallback = join(stateDir(), "bin", "scrcpy-decode");
  if (isFresh(fallback)) return fallback;
  log(`building native decoder into ${fallback}`);
  const build = Bun.spawnSync(["sh", BUILD_SCRIPT, fallback], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    const detail = build.stderr.toString().trim().split("\n").pop() ?? "";
    throw new Error(`building the native decoder failed: ${detail}`);
  }
  return fallback;
}

export interface Frame {
  /** Raw RGBA file written by the decoder; the consumer owns (and deletes) it. */
  path: string;
  width: number;
  height: number;
}

export class Decoder {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;

  /**
   * `prefix` is the frame file path prefix; frames land at `${prefix}${seq}.rgba`.
   * `onExit` fires if the decoder process dies without `stop()` being called.
   */
  constructor(
    bin: string,
    private prefix: string,
    onFrame: (f: Frame) => void,
    log: (msg: string) => void,
    onExit: (code: number | null) => void,
  ) {
    const proc = (this.proc = Bun.spawn([bin, prefix], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    proc.exited.then((code) => {
      if (!this.stopped) onExit(code);
    });
    void this.readFrames(onFrame);
    void (async () => {
      const dec = new TextDecoder();
      for await (const c of proc.stderr) {
        const msg = dec.decode(c).trim();
        // swscale warns once that it has no SIMD path for yuv420p->rgba on arm64; harmless.
        if (!this.stopped && !msg.includes("No accelerated colorspace conversion")) log(`[decoder] ${msg}`);
      }
    })();
  }

  private async readFrames(onFrame: (f: Frame) => void) {
    const dec = new TextDecoder();
    let pending = "";
    for await (const chunk of this.proc.stdout) {
      pending += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const [seq, w, h] = pending.slice(0, nl).split(" ");
        pending = pending.slice(nl + 1);
        if (!this.stopped) onFrame({ path: `${this.prefix}${seq}.rgba`, width: Number(w), height: Number(h) });
      }
    }
  }

  push(packet: Buffer, config: boolean) {
    if (this.stopped) return;
    const hdr = Buffer.alloc(5);
    hdr.writeUInt32BE(packet.length, 0);
    hdr[4] = config ? 1 : 0;
    try {
      this.proc.stdin.write(hdr);
      this.proc.stdin.write(packet);
      this.proc.stdin.flush();
    } catch {
      // The decoder died; its exit handler restarts the session.
    }
  }

  stop() {
    this.stopped = true;
    try {
      this.proc.stdin.end();
    } catch {}
    this.proc.kill();
  }
}
