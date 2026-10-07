// Minimal scrcpy 5.x client: pushes and starts scrcpy-server, opens the video
// and control sockets over an adb forward tunnel, and parses the video framing.
// Protocol reference: scrcpy/doc/develop.md and server/.../device/Streamer.java.
import { connect, type Socket } from "node:net";
import type { Subprocess } from "bun";

const REMOTE_JAR = "/data/local/tmp/scrcpy-server.jar";
const CODEC_H264 = 0x68323634;

export interface SessionOptions {
  serial: string;
  serverPath: string;
  serverVersion: string;
  maxSize: number;
  maxFps: number;
  videoBitRate: number;
  log: (msg: string) => void;
}

export interface Handlers {
  /** New capture session (start or rotation); `width`x`height` is the video size. */
  onSession(width: number, height: number): void;
  /** `pts` is the device capture time in µs (device clock), 0 for config packets. */
  onPacket(data: Buffer, config: boolean, keyFrame: boolean, pts: number): void;
  onClose(reason: string): void;
}

/** Buffered exact-length reads on a socket. */
class Reader {
  private chunks: Buffer[] = [];
  private size = 0;
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private ended: Error | null = null;

  constructor(sock: Socket) {
    sock.on("data", (d: Buffer) => {
      this.chunks.push(d);
      this.size += d.length;
      this.pump();
    });
    const end = () => {
      this.ended ??= new Error("socket closed");
      this.waiter?.reject(this.ended);
      this.waiter = null;
    };
    sock.on("end", end);
    sock.on("close", end);
    sock.on("error", (e) => {
      this.ended = e;
      end();
    });
  }

  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
      this.pump();
      if (this.waiter && this.ended) {
        this.waiter = null;
        reject(this.ended);
      }
    });
  }

  private pump() {
    if (!this.waiter || this.size < this.waiter.n) return;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    const { n, resolve } = this.waiter;
    this.waiter = null;
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    resolve(out);
  }
}

/**
 * Runs adb asynchronously and kills it after `timeoutMs`, so an unresponsive
 * device can neither hang the mirror nor block its input handling (Bun's
 * spawnSync is blocking, and older Bun versions ignore its timeout option).
 */
const runningAdb = new Set<Subprocess>();

/** Kills adb calls still in flight; call before exiting so none outlive the mirror. */
export function killRunningAdb() {
  for (const proc of runningAdb) proc.kill();
  runningAdb.clear();
}

async function runAdb(args: string[], timeoutMs = 15_000): Promise<string> {
  const proc = Bun.spawn(["adb", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  runningAdb.add(proc);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  runningAdb.delete(proc);
  if (timedOut) throw new Error(`adb ${args.join(" ")} timed out after ${timeoutMs / 1000}s`);
  if (code !== 0) throw new Error(`adb ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`);
  return stdout;
}

export interface Device {
  serial: string;
  /** adb state: "device" (ready), "unauthorized", "offline", ... */
  state: string;
  /** Model from `adb devices -l` (underscores turned into spaces), if reported. */
  model?: string;
}

/** Parses `adb devices -l` output. */
export function parseDevices(out: string): Device[] {
  return out
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[0] !== "")
    .map(([serial, state, ...rest]) => {
      const model = rest.find((f) => f.startsWith("model:"))?.slice("model:".length).replace(/_/g, " ");
      return model ? { serial, state, model } : { serial, state };
    });
}

export async function listDevices(): Promise<Device[]> {
  return parseDevices(await runAdb(["devices", "-l"], 10_000));
}

/** Current screen size in px (an `Override size` from `wm size` wins over the physical one). */
export async function screenSize(serial: string): Promise<{ width: number; height: number } | null> {
  const out = await runAdb(["-s", serial, "shell", "wm", "size"], 10_000).catch(() => "");
  const m = out.match(/Override size: (\d+)x(\d+)/) ?? out.match(/Physical size: (\d+)x(\d+)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export type VideoHeader =
  | { kind: "session"; width: number; height: number }
  | { kind: "media"; config: boolean; keyFrame: boolean; pts: number; length: number };

/**
 * Parses a 12-byte scrcpy 5 video header: a session packet (MSB set; width and
 * height, sent on start and rotation) or a media packet header (config and
 * key-frame flags, 61-bit PTS in µs, payload length).
 */
export function parseVideoHeader(hdr: Buffer): VideoHeader {
  if (hdr[0] & 0x80) return { kind: "session", width: hdr.readUInt32BE(4), height: hdr.readUInt32BE(8) };
  const config = (hdr[0] & 0x40) !== 0;
  return {
    kind: "media",
    config,
    keyFrame: (hdr[0] & 0x20) !== 0,
    pts: config ? 0 : Number(hdr.readBigUInt64BE(0) & ((1n << 61n) - 1n)),
    length: hdr.readUInt32BE(8),
  };
}

function tryConnect(port: number): Promise<{ sock: Socket; reader: Reader } | null> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    sock.setNoDelay(true);
    const reader = new Reader(sock);
    sock.once("error", () => resolve(null));
    // With a forward tunnel the TCP connect always succeeds; the dummy byte
    // proves the server is actually listening on the device side.
    reader.read(1).then(
      () => resolve({ sock, reader }),
      () => {
        sock.destroy();
        resolve(null);
      },
    );
  });
}

export class ScrcpySession {
  deviceName = "";
  width = 0;
  height = 0;
  private server: Subprocess | null = null;
  private port = 0;
  private video: Socket | null = null;
  private control: Socket | null = null;
  private closed = false;
  /** Last error line printed by scrcpy-server (e.g. a version mismatch), for error messages. */
  lastServerError = "";

  constructor(private opts: SessionOptions) {}

  async start(h: Handlers) {
    const { serial, log } = this.opts;
    const scid = (Math.random() * 0x7fffffff) | 0;
    const scidHex = scid.toString(16).padStart(8, "0");

    await runAdb(["-s", serial, "push", this.opts.serverPath, REMOTE_JAR], 30_000);
    this.port = Number((await runAdb(["-s", serial, "forward", "tcp:0", `localabstract:scrcpy_${scidHex}`])).trim());
    log(`forward tcp:${this.port} -> scrcpy_${scidHex}`);

    const serverArgs = [
      `CLASSPATH=${REMOTE_JAR}`, "app_process", "/", "com.genymobile.scrcpy.Server", this.opts.serverVersion,
      `scid=${scidHex}`, "log_level=info", "tunnel_forward=true",
      "audio=false", "control=true", "video_codec=h264",
      `max_size=${this.opts.maxSize}`, `max_fps=${this.opts.maxFps}`, `video_bit_rate=${this.opts.videoBitRate}`,
      "clipboard_autosync=false", "cleanup=true",
    ];
    log(`server: ${serverArgs.join(" ")}`);
    this.server = Bun.spawn(["adb", "-s", serial, "shell", ...serverArgs], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const logsDone = Promise.allSettled([
      this.pipeLog(this.server.stdout as ReadableStream<Uint8Array>, "server"),
      this.pipeLog(this.server.stderr as ReadableStream<Uint8Array>, "server!"),
    ]);
    this.server.exited.then(async (code) => {
      // Read the server's last output first, so its own error (e.g. a version
      // mismatch) can be shown instead of just the exit code.
      await logsDone;
      this.close(h, this.lastServerError ? `scrcpy-server: ${this.lastServerError}` : `server exited (${code})`);
    });

    let first: Awaited<ReturnType<typeof tryConnect>> = null;
    for (let i = 0; i < 100 && !first && !this.closed; i++) {
      first = await tryConnect(this.port);
      if (!first) await Bun.sleep(100);
    }
    if (!first) throw new Error(this.lastServerError || "could not connect to scrcpy-server");
    this.video = first.sock;
    const video = first.reader;

    // Second socket (audio disabled): control. No dummy byte on this one.
    this.control = connect(this.port, "127.0.0.1");
    this.control.setNoDelay(true);
    this.control.on("data", () => {}); // drain device messages (clipboard etc.)
    this.control.on("error", (e) => log(`control error: ${e.message}`));

    const name = await video.read(64);
    this.deviceName = name.subarray(0, name.indexOf(0) >= 0 ? name.indexOf(0) : 64).toString("utf8");
    const codec = (await video.read(4)).readUInt32BE(0);
    if (codec !== CODEC_H264) throw new Error(`unexpected codec 0x${codec.toString(16)}`);
    log(`device "${this.deviceName}", codec h264`);

    this.video.on("close", () => this.close(h, "video socket closed"));
    void this.readLoop(video, h).catch((e) => this.close(h, `video: ${e.message}`));
  }

  private async readLoop(r: Reader, h: Handlers) {
    while (!this.closed) {
      const hdr = parseVideoHeader(await r.read(12));
      if (hdr.kind === "session") {
        this.width = hdr.width;
        this.height = hdr.height;
        h.onSession(this.width, this.height);
        continue;
      }
      const data = await r.read(hdr.length);
      h.onPacket(data, hdr.config, hdr.keyFrame, hdr.pts);
    }
  }

  private async pipeLog(stream: ReadableStream<Uint8Array>, tag: string) {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      for (const raw of dec.decode(chunk).split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        this.opts.log(`[${tag}] ${line}`);
        const error = line.match(/ERROR:\s*(.*)$/);
        if (error) this.lastServerError = error[1];
      }
    }
  }

  send(msg: Buffer) {
    if (!this.closed) this.control?.write(msg);
  }

  private close(h: Handlers, reason: string) {
    if (this.closed) return;
    this.stop();
    h.onClose(reason);
  }

  /**
   * Closes the sockets, stops the server and removes the adb forward. Pass
   * `{ exiting: true }` when the process is about to exit: the forward is then
   * removed synchronously, since an asynchronous removal would be cut short.
   */
  stop({ exiting = false }: { exiting?: boolean } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.video?.destroy();
    this.control?.destroy();
    this.server?.kill();
    if (!this.port) return;
    const args = ["-s", this.opts.serial, "forward", "--remove", `tcp:${this.port}`];
    if (exiting) Bun.spawnSync(["adb", ...args], { timeout: 3000, stdout: "ignore", stderr: "ignore" });
    else void runAdb(args).catch(() => {});
  }
}

// ---- control messages (client -> device), see ControlMessageReader.java ----

export const Action = { DOWN: 0, UP: 1, MOVE: 2 } as const;
const POINTER_ID_GENERIC_FINGER = -2n;

export const Keycode = {
  HOME: 3, BACK: 4, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
  TAB: 61, ENTER: 66, DEL: 67, ESCAPE: 111, FORWARD_DEL: 112, APP_SWITCH: 187,
  PAGE_UP: 92, PAGE_DOWN: 93, MOVE_HOME: 122, MOVE_END: 123,
} as const;

function writePosition(b: Buffer, off: number, x: number, y: number, w: number, h: number) {
  b.writeInt32BE(Math.round(x), off);
  b.writeInt32BE(Math.round(y), off + 4);
  b.writeUInt16BE(w, off + 8);
  b.writeUInt16BE(h, off + 10);
}

export function touchMsg(action: number, x: number, y: number, w: number, h: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 2;
  b[1] = action;
  b.writeBigInt64BE(POINTER_ID_GENERIC_FINGER, 2);
  writePosition(b, 10, x, y, w, h);
  b.writeUInt16BE(action === Action.UP ? 0 : 0xffff, 22); // pressure
  b.writeInt32BE(0, 24); // action button
  b.writeInt32BE(0, 28); // buttons
  return b;
}

/** `v`/`hv` in scroll "clicks" (range [-16, 16]). */
export function scrollMsg(x: number, y: number, w: number, h: number, hv: number, v: number): Buffer {
  const fp = (f: number) => Math.max(-0x8000, Math.min(0x7fff, Math.round((f / 16) * 0x8000)));
  const b = Buffer.alloc(21);
  b[0] = 3;
  writePosition(b, 1, x, y, w, h);
  b.writeInt16BE(fp(hv), 13);
  b.writeInt16BE(fp(v), 15);
  b.writeInt32BE(0, 17);
  return b;
}

export function keycodeMsg(action: number, keycode: number, metaState = 0): Buffer {
  const b = Buffer.alloc(14);
  b[0] = 0;
  b[1] = action;
  b.writeInt32BE(keycode, 2);
  b.writeInt32BE(0, 6); // repeat
  b.writeInt32BE(metaState, 10);
  return b;
}

export function textMsg(text: string): Buffer {
  const utf8 = Buffer.from(text, "utf8").subarray(0, 300);
  const b = Buffer.alloc(5 + utf8.length);
  b[0] = 1;
  b.writeUInt32BE(utf8.length, 1);
  utf8.copy(b, 5);
  return b;
}

export function keyPress(keycode: number): Buffer[] {
  return [keycodeMsg(Action.DOWN, keycode), keycodeMsg(Action.UP, keycode)];
}
