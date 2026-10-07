// Headless check of the video path: bun src/probe.ts [seconds] [out.png]
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { loadConfig, resolveServer } from "./config";
import { Decoder, decoderBinary } from "./decoder";
import { createFrameDir } from "./files";
import { listDevices, ScrcpySession } from "./scrcpy";

const seconds = Number(process.argv[2] ?? 5);
const outPng = process.argv[3];
const cfg = loadConfig();
const server = resolveServer(cfg);
const serial = cfg.serial || (await listDevices()).find((d) => d.state === "device")?.serial;
if (!serial) throw new Error("no authorized adb device");

const log = (m: string) => console.error(`${(performance.now() / 1000).toFixed(2)}s ${m}`);
log(`device ${serial}, server ${server.version} @ ${server.path}`);

let decoder = null as Decoder | null;
let frames = 0, packets = 0, packetBytes = 0, zBytes = 0, zMs = 0;
let last: Buffer | null = null;
let firstFrameAt = 0;
const t0 = performance.now();

const session = new ScrcpySession({
  serial, serverPath: server.path, serverVersion: server.version,
  maxSize: cfg.max_size, maxFps: cfg.max_fps, videoBitRate: cfg.video_bit_rate, log,
});

const frameDir = createFrameDir();
decoder = new Decoder(decoderBinary(log), join(frameDir, "tty-graphics-protocol-"), (f) => {
  const rgb = readFileSync(f.path);
  rmSync(f.path, { force: true });
  if (!frames) firstFrameAt = performance.now();
  frames++;
  const t = performance.now();
  zBytes += deflateSync(rgb, { level: 1 }).length;
  zMs += performance.now() - t;
  last = rgb;
}, log, (code) => log(`decoder exited (code ${code})`));

await session.start({
  onSession(w, h) {
    log(`session ${w}x${h}`);
  },
  onPacket(data, config) {
    packets++;
    packetBytes += data.length;
    decoder?.push(data, config);
  },
  onClose(reason) {
    log(`closed: ${reason}`);
  },
});
log(`connected in ${((performance.now() - t0) / 1000).toFixed(2)}s`);

await Bun.sleep(seconds * 1000);
const { width: w, height: h } = session;
session.stop();
(decoder as Decoder | null)?.stop();
rmSync(frameDir, { recursive: true, force: true });

const kb = (n: number) => (n / 1024).toFixed(0) + " KB";
log(`video ${w}x${h}; first frame after ${((firstFrameAt - t0) / 1000).toFixed(2)}s`);
log(`${packets} packets (${kb(packetBytes)}), ${frames} frames decoded`);
if (frames) {
  const raw = w * h * 4;
  const z = zBytes / frames;
  log(`per frame: raw ${kb(raw)}, zlib ${kb(z)} (${(zMs / frames).toFixed(1)} ms), base64 ${kb((z * 4) / 3)}`);
  log(`at ${cfg.max_fps} fps that is ~${((((z * 4) / 3) * cfg.max_fps) / 1024 / 1024).toFixed(1)} MB/s to the terminal`);
}
if (outPng && last) {
  const p = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${w}x${h}`, "-i", "pipe:0", outPng], { stdin: "pipe" });
  p.stdin.write(last);
  p.stdin.end();
  await p.exited;
  log(`wrote ${outPng}`);
}
process.exit(0);
