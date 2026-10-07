// herdr pane entrypoint: mirrors an Android device into this pane using Kitty
// graphics and forwards mouse/keyboard input to it over scrcpy's control socket.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveServer, stateDir } from "./config";
import { Decoder, decoderBinary, type Frame } from "./decoder";
import { createFrameDir, createLogger } from "./files";
import { chooseDevice, deviceLabel, DevicePicker } from "./picker";
import {
  Action, Keycode, keyPress, killRunningAdb, listDevices, screenSize, scrollMsg, ScrcpySession, textMsg, touchMsg,
  type Device,
} from "./scrcpy";
import { InputParser, kittyFileFrame, kittyFrame, term, type InputEvent } from "./terminal";

// In a plain terminal we double-buffer: alternate two image ids and delete the
// old one after placing the new, so there is never a blank gap. Inside herdr we
// must reuse ONE id: herdr double-buffers towards the host terminal itself, and
// a changing image id permanently drops it off its fast file-based path.
const IMAGE_IDS = [7031, 7032];
const doubleBuffer = !process.env.HERDR_PANE_ID;
let front = 0;
const log = createLogger(join(stateDir(), "mirror.log"));
log("---- start ----");
// Frame files (and the temp-file probe) live in a private 0700 directory,
// removed on exit; directories of mirrors that died are swept on startup.
const frameDir = createFrameDir();

const cfg = loadConfig();
const out = process.stdout;
const write = (s: string) => out.write(s);

// The phone picked last time is preselected in the picker.
const lastDeviceFile = join(stateDir(), "last-device");
let lastDevice: string | null = null;
try {
  lastDevice = readFileSync(lastDeviceFile, "utf8").trim() || null;
} catch {}

// ---- terminal geometry ----
let cellW = 0, cellH = 0, textAreaW = 0, textAreaH = 0;
let kittyOk: boolean | null = null;
const cols = () => out.columns || 80;
const rows = () => out.rows || 24;
function cellSize(): [number, number] {
  if (cellW && cellH) return [cellW, cellH];
  if (textAreaW && textAreaH) return [textAreaW / cols(), textAreaH / rows()];
  return [10, 20]; // assume ~1:2 cells
}

/** Where the image sits, in cells (0-based), for the current video size. */
let layout = { col0: 0, row0: 0, cols: 1, rows: 1 };
function relayout(w: number, h: number) {
  const [cw, ch] = cellSize();
  const availCols = cols(), availRows = Math.max(1, rows() - 1); // last row = status line
  const scale = Math.min((availCols * cw) / w, (availRows * ch) / h);
  const c = Math.max(1, Math.min(availCols, Math.round((w * scale) / cw)));
  const r = Math.max(1, Math.min(availRows, Math.round((h * scale) / ch)));
  layout = { col0: Math.floor((availCols - c) / 2), row0: 0, cols: c, rows: r };
  if (picker) return; // the picker owns the screen; the image comes back when it closes
  write(term.clear);
  dirty = latest !== null;
  scheduleRender();
}

// ---- status line ----
let status = "starting…";
let stats = { frames: 0, drawn: 0, bytes: 0, since: performance.now() };
let fpsText = "";
function drawStatus() {
  const hint = picker
    ? "choose a phone · ^q=quit"
    : "click=tap drag=swipe wheel=scroll rclick/esc=back ^o=home ^s=apps ^d=device ^q=quit";
  const line = ` ${status}${fpsText && !picker ? " · " + fpsText : ""} │ ${hint}`;
  write(`${term.moveTo(rows() - 1, 0)}${term.clearLine}\x1b[2m${line.slice(0, cols())}\x1b[0m`);
}
setInterval(() => {
  const dt = (performance.now() - stats.since) / 1000;
  fpsText = `${(stats.drawn / dt).toFixed(1)} fps · ${(stats.bytes / dt / 1024).toFixed(0)} KB/s`;
  if (stats.frames) log(`stats: decoded ${(stats.frames / dt).toFixed(1)}/s drawn ${(stats.drawn / dt).toFixed(1)}/s out ${(stats.bytes / dt / 1024).toFixed(0)} KB/s | ${latencyReport()}`);
  for (const k of Object.keys(lat) as (keyof typeof lat)[]) lat[k] = 0;
  stats = { frames: 0, drawn: 0, bytes: 0, since: performance.now() };
  drawStatus();
}, 2000);

// ---- latency instrumentation (ms, averaged per stats window) ----
// net: packet arrival relative to device PTS, minus the minimum seen (= queueing on the adb path)
// dec: packet pushed to the decoder -> RGBA frame out
// wait: frame decoded -> drawn (fps cap / backpressure)
// enc: building the Kitty command (temp file write, or zlib+base64 for direct)
// drain: write() -> stdout buffer flushed into the pty (backpressure from herdr)
const lat = { net: 0, netN: 0, dec: 0, decN: 0, wait: 0, enc: 0, drain: 0, drainN: 0, n: 0 };
let ptsOffsetMin = Infinity;
const pushTimes: number[] = [];
let latestAt = 0;
function latencyReport(): string {
  const a = (sum: number, n: number) => (n ? (sum / n).toFixed(0) : "-");
  return `${transfer} | net+${a(lat.net, lat.netN)} dec ${a(lat.dec, lat.decN)} wait ${a(lat.wait, lat.n)} enc ${a(lat.enc, lat.n)} drain ${a(lat.drain, lat.drainN)} ms`;
}

// ---- frame transfer ----
// "file": raw RGBA goes to a temp file and only its path crosses the pty (Kitty t=t),
// so there is no compression or base64 on the hot path. "direct" (zlib+base64
// inline) is the fallback for terminals that refuse file transfer.
let transfer: "file" | "direct" = cfg.transfer === "direct" ? "direct" : "file";
// Frames handed to the terminal (t=t) are deleted by it after reading; this is
// only a sweep for any it leaves behind.
const sentFiles: string[] = [];
function sent(path: string) {
  sentFiles.push(path);
  while (sentFiles.length > 30) rmSync(sentFiles.shift()!, { force: true });
}
let decoderSeq = 0;

// ---- render: draw as soon as a frame arrives; latest frame wins ----
// Frames are spaced by the fps cap and the data budget (max_mb_per_sec), and
// held back while stdout is backed up, so a slow terminal drops frames instead
// of queueing them.
let latest: Frame | null = null;
let dirty = false;
let backedUp = false;
let vw = 0, vh = 0;
let lastRenderAt = 0;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
function minInterval(): number {
  const fpsInterval = 1000 / cfg.max_fps;
  if (!cfg.max_mb_per_sec || !latest) return fpsInterval;
  const frameMB = (latest.width * latest.height * 4) / (1024 * 1024);
  return Math.max(fpsInterval, (frameMB / cfg.max_mb_per_sec) * 1000);
}

function scheduleRender() {
  if (renderTimer || backedUp || !dirty || picker) return;
  const wait = lastRenderAt + minInterval() - performance.now();
  if (wait <= 0) render();
  else renderTimer = setTimeout(() => { renderTimer = null; render(); }, wait);
}

function render() {
  if (!latest || !dirty || backedUp || !vw || picker) return;
  dirty = false;
  const tStart = (lastRenderAt = performance.now());
  lat.wait += tStart - latestAt;
  const back = doubleBuffer ? front ^ 1 : front;
  const opts = { id: IMAGE_IDS[back], cols: layout.cols, rows: layout.rows };
  let img: string;
  if (transfer === "file") {
    img = kittyFileFrame(latest.path, latest.width, latest.height, opts);
    sent(latest.path);
  } else {
    img = kittyFrame(readFileSync(latest.path), latest.width, latest.height, opts);
    rmSync(latest.path, { force: true });
  }
  const s = term.moveTo(layout.row0, layout.col0) + img + (doubleBuffer ? term.deleteImage(IMAGE_IDS[front]) : "");
  front = back;
  const tEnc = performance.now();
  lat.enc += tEnc - tStart;
  lat.n++;
  stats.drawn++;
  stats.bytes += s.length;
  if (!out.write(s, () => { lat.drain += performance.now() - tEnc; lat.drainN++; })) {
    backedUp = true;
    out.once("drain", () => {
      backedUp = false;
      scheduleRender();
    });
  }
}

const clearImages = () => IMAGE_IDS.map(term.deleteImage).join("");

// ---- device session lifecycle ----
// One session at a time. `generation` changes whenever a session is replaced,
// so late callbacks from an old session or decoder are ignored, and all
// (re)starts go through a single timer so two failures can't start two sessions.
let session: ScrcpySession | null = null;
let decoder: Decoder | null = null;
let currentSerial: string | null = null;
/** Phone explicitly chosen in the picker during this run. */
let chosenSerial: string | null = null;
let generation = 0;
let startTimer: ReturnType<typeof setTimeout> | null = null;
/** Failed attempts since the last working stream; drives the retry backoff. */
let failures = 0;

function scheduleStart(ms: number) {
  if (quitting) return;
  if (startTimer) clearTimeout(startTimer);
  startTimer = setTimeout(() => {
    startTimer = null;
    void startSession();
  }, ms);
}

function stopSession({ exiting = false }: { exiting?: boolean } = {}) {
  generation++;
  session?.stop({ exiting });
  session = null;
  decoder?.stop();
  decoder = null;
  if (latest) rmSync(latest.path, { force: true });
  latest = null;
  dirty = false;
}

/** Ends the current session (if any), shows `message`, and starts again after `ms`. */
function restart(message: string, ms: number) {
  stopSession();
  status = message;
  log(message);
  drawStatus();
  scheduleStart(ms);
}

/**
 * Like restart, for failures: repeated failures back off (2 s, 4 s, 8 s, up to
 * 30 s) so a persistent problem doesn't re-push the server to the phone every
 * couple of seconds. A working stream resets the backoff.
 */
function retryAfterFailure(message: string) {
  const ms = Math.min(30_000, 2000 * 2 ** failures);
  failures++;
  restart(`${message} — retrying in ${Math.round(ms / 1000)}s`, ms);
}

/** Frame rate that fits the data budget at the video size scrcpy will produce. */
function budgetFps(width: number, height: number): number {
  if (!cfg.max_mb_per_sec) return cfg.max_fps;
  return Math.min(cfg.max_fps, cfg.max_mb_per_sec / ((width * height * 4) / (1024 * 1024)));
}

/**
 * Asks the phone's encoder for no more frames than the terminal budget allows,
 * so frames that would be dropped anyway are never encoded, sent or decoded.
 * scrcpy scales the long side to max_size and keeps the aspect ratio.
 */
async function encoderFps(serial: string, maxSize: number): Promise<number> {
  const screen = await screenSize(serial);
  if (!screen) return cfg.max_fps;
  const scale = Math.min(1, maxSize / Math.max(screen.width, screen.height));
  return Math.max(1, Math.floor(budgetFps(screen.width * scale, screen.height * scale)));
}

async function startSession() {
  if (quitting || picker) return;
  const gen = ++generation;
  // Everything before the stream starts can fail on a missing or misconfigured
  // dependency or a flaky device; report it in the pane and retry instead of
  // letting the process die.
  let serial: string, server: { path: string; version: string }, bin: string;
  let maxSize: number, deviceFps: number;
  try {
    if (!Bun.which("adb")) throw new Error("adb not found on PATH; install Android platform-tools");
    const devices = await listDevices();
    if (gen !== generation || picker) return;
    const choice = chooseDevice(devices, { configured: cfg.serial || undefined, chosen: chosenSerial });
    if ("wait" in choice) {
      status = `${choice.wait} (retrying)`;
      drawStatus();
      scheduleStart(2000);
      return;
    }
    if ("pick" in choice) {
      openPicker(false, devices);
      return;
    }
    serial = choice.serial;
    server = resolveServer(cfg);
    bin = decoderBinary(log);
    // Never ask the device for more pixels than the pane can show.
    const paneHeightPx = Math.round(cellSize()[1] * Math.max(1, rows() - 1));
    maxSize = Math.max(200, Math.min(cfg.max_size, paneHeightPx));
    const label = deviceLabel(devices.find((d) => d.serial === serial) ?? { serial, state: "device" });
    status = `connecting to ${label}…`;
    drawStatus();
    deviceFps = await encoderFps(serial, maxSize);
    if (gen !== generation || picker) return;
    log(`start session serial=${serial} max_size=${maxSize} (cfg ${cfg.max_size}, pane ${paneHeightPx}px) device fps=${deviceFps} (cfg max ${cfg.max_fps})`);
  } catch (e) {
    if (gen !== generation) return;
    retryAfterFailure(`error: ${(e as Error).message}`);
    return;
  }

  currentSerial = serial;
  decoder = new Decoder(
    bin,
    join(frameDir, `tty-graphics-protocol-${decoderSeq++}-`),
    (frame) => {
      stats.frames++;
      const t = performance.now();
      const pushed = pushTimes.shift();
      if (pushed !== undefined) { lat.dec += t - pushed; lat.decN++; }
      // A frame that was never drawn is superseded: drop its file now.
      if (latest && dirty) rmSync(latest.path, { force: true });
      latest = frame;
      latestAt = t;
      dirty = true;
      scheduleRender();
    },
    log,
    (code) => {
      if (gen === generation) retryAfterFailure(`decoder exited (code ${code})`);
    },
  );

  const thisSession = (session = new ScrcpySession({
    serial, serverPath: server.path, serverVersion: server.version,
    maxSize, maxFps: deviceFps, videoBitRate: cfg.video_bit_rate, log,
  }));
  try {
    await thisSession.start({
      onSession(w, h) {
        if (gen !== generation) return;
        log(`video session ${w}x${h}`);
        failures = 0;
        pushTimes.length = 0;
        ptsOffsetMin = Infinity;
        vw = w;
        vh = h;
        latest = null;
        relayout(w, h);
        const cap = budgetFps(w, h);
        log(`frame cap ${cap.toFixed(1)} fps (max_fps ${cfg.max_fps}, budget ${cfg.max_mb_per_sec} MB/s)`);
        status = `${thisSession.deviceName} ${w}x${h} ≤${cap.toFixed(0)}fps`;
        drawStatus();
      },
      onPacket(data, config, _key, pts) {
        if (gen !== generation) return;
        if (!config) {
          const now = performance.now();
          const off = now - pts / 1000;
          ptsOffsetMin = Math.min(ptsOffsetMin, off);
          lat.net += off - ptsOffsetMin;
          lat.netN++;
          pushTimes.push(now);
          if (pushTimes.length > 64) pushTimes.shift();
        }
        decoder?.push(data, config);
      },
      onClose(reason) {
        log(`session closed: ${reason}`);
        if (gen === generation) retryAfterFailure(`disconnected (${reason})`);
      },
    });
  } catch (e) {
    if (gen !== generation) return;
    retryAfterFailure(`error: ${(e as Error).message}`);
  }
}

// ---- device picker (several phones, or Ctrl+D) ----
let picker: DevicePicker | null = null;
let pickerTimer: ReturnType<typeof setInterval> | null = null;

function drawPicker() {
  if (!picker) return;
  write(picker.render(cols()));
  drawStatus();
}

async function refreshPicker() {
  try {
    const devices = await listDevices();
    if (!picker) return;
    picker.setDevices(devices);
    // Opened only because several phones were connected: if that is no longer
    // the case, just mirror whatever is there.
    if (!picker.manual && devices.filter((d) => d.state === "device").length <= 1) {
      closePicker();
      scheduleStart(0);
      return;
    }
    drawPicker();
  } catch (e) {
    status = `error: ${(e as Error).message}`;
    drawStatus();
  }
}

function openPicker(manual: boolean, devices?: Device[]) {
  if (picker) return;
  picker = new DevicePicker(manual, currentSerial ?? lastDevice);
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  if (devices) picker.setDevices(devices);
  status = manual ? "switch device" : "several phones connected";
  write(clearImages());
  drawPicker();
  void refreshPicker();
  pickerTimer = setInterval(refreshPicker, 2000);
}

function closePicker() {
  if (pickerTimer) clearInterval(pickerTimer);
  pickerTimer = null;
  picker = null;
  write(term.clear);
  if (vw) relayout(vw, vh);
  drawStatus();
  // Opening the picker pauses (re)connect attempts; resume them if nothing is running.
  if (!session) scheduleStart(0);
}

function pickChosen() {
  const device = picker?.chosen();
  if (!device) return; // unauthorized or offline: stay in the picker
  chosenSerial = lastDevice = device.serial;
  try {
    writeFileSync(lastDeviceFile, device.serial);
  } catch {}
  const switching = device.serial !== currentSerial || !session;
  closePicker();
  if (switching) {
    vw = vh = 0;
    restart(`connecting to ${deviceLabel(device)}…`, 0);
  }
}

function onPickerInput(e: InputEvent) {
  if (!picker) return;
  switch (e.type) {
    case "key":
      if (e.name === "up") picker.move(-1);
      else if (e.name === "down") picker.move(1);
      else if (e.name === "enter") return pickChosen();
      else if (e.name === "escape" && picker.manual) return closePicker();
      break;
    case "text": {
      const n = Number(e.text.trim());
      if (Number.isInteger(n) && picker.select(n - 1)) return pickChosen();
      break;
    }
    case "mouse": {
      if (e.button === 64 || e.button === 65) picker.move(e.button === 64 ? -1 : 1);
      else if (e.button === 0 && e.press && !e.motion) {
        const i = picker.rowAt(e.y);
        if (i !== null && picker.select(i)) return pickChosen();
      }
      break;
    }
    case "ctrl":
      if (e.char === "q" || e.char === "c") quit();
      return;
    default:
      return;
  }
  drawPicker();
}

// ---- input ----
function toDevice(x: number, y: number): [number, number] | null {
  // SGR mouse coords are 1-based cells; map the cell centre into video pixels.
  const cx = x - 1 - layout.col0 + 0.5, cy = y - 1 - layout.row0 + 0.5;
  if (cx < 0 || cy < 0 || cx > layout.cols || cy > layout.rows) return null;
  return [(cx / layout.cols) * vw, (cy / layout.rows) * vh];
}
let touching = false;
let lastTouch: [number, number] = [0, 0];
const send = (...msgs: Buffer[]) => msgs.forEach((m) => session?.send(m));

const KEYMAP: Record<string, number> = {
  enter: Keycode.ENTER, backspace: Keycode.DEL, delete: Keycode.FORWARD_DEL, tab: Keycode.TAB,
  up: Keycode.DPAD_UP, down: Keycode.DPAD_DOWN, left: Keycode.DPAD_LEFT, right: Keycode.DPAD_RIGHT,
  home: Keycode.MOVE_HOME, end: Keycode.MOVE_END, pageup: Keycode.PAGE_UP, pagedown: Keycode.PAGE_DOWN,
  escape: Keycode.BACK,
};

function onInput(e: InputEvent) {
  // Terminal replies are handled in any mode.
  if (e.type === "reply") {
    log(`terminal reply ${e.kind} ${e.w}x${e.h}`);
    if (e.kind === "cellPx") [cellW, cellH] = [e.w, e.h];
    else [textAreaW, textAreaH] = [e.w, e.h];
    return;
  }
  if (e.type === "kitty") {
    log(`kitty reply: ${e.payload}`);
    if (e.payload.startsWith("Gi=31")) kittyOk = e.payload.includes("OK");
    if (e.payload.startsWith("Gi=34") && !e.payload.includes("OK") && transfer === "file") {
      transfer = "direct";
      log("terminal refused temp-file transfer; falling back to direct");
    }
    return;
  }
  if (picker) return onPickerInput(e);
  switch (e.type) {
    case "mouse": {
      if (!vw) return;
      const p = toDevice(e.x, e.y);
      if (e.button === 64 || e.button === 65) {
        if (p) send(scrollMsg(p[0], p[1], vw, vh, 0, e.button === 64 ? 1 : -1));
      } else if (e.button === 0 && e.press && !e.motion) {
        if (p) { touching = true; lastTouch = p; send(touchMsg(Action.DOWN, p[0], p[1], vw, vh)); }
      } else if (e.button === 0 && e.motion && touching) {
        if (p) lastTouch = p;
        send(touchMsg(Action.MOVE, lastTouch[0], lastTouch[1], vw, vh));
      } else if (!e.press && touching) {
        touching = false;
        if (p) lastTouch = p;
        send(touchMsg(Action.UP, lastTouch[0], lastTouch[1], vw, vh));
      } else if (e.button === 2 && e.press) {
        send(...keyPress(Keycode.BACK));
      }
      return;
    }
    case "key":
      if (KEYMAP[e.name] !== undefined) send(...keyPress(KEYMAP[e.name]));
      else log(`unmapped key ${e.name}`);
      return;
    case "text":
      send(textMsg(e.text));
      return;
    case "ctrl":
      if (e.char === "q" || e.char === "c") quit();
      else if (e.char === "d") openPicker(true);
      else if (e.char === "o") send(...keyPress(Keycode.HOME));
      else if (e.char === "s") send(...keyPress(Keycode.APP_SWITCH));
      else if (e.char === "b") send(...keyPress(Keycode.BACK));
      return;
  }
}

// Input is never logged verbatim: it includes whatever is typed into the phone.
const parser = new InputParser(onInput);

let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  log("quit");
  if (startTimer) clearTimeout(startTimer);
  if (pickerTimer) clearInterval(pickerTimer);
  stopSession({ exiting: true });
  killRunningAdb();
  rmSync(frameDir, { recursive: true, force: true });
  try {
    process.stdin.setRawMode?.(false);
  } catch {}
  out.write(clearImages() + term.leave, () => process.exit(0));
  setTimeout(() => process.exit(0), 300);
}
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, quit);
// Last line of defence: an unexpected error is logged and shown in the status
// line rather than killing the pane, which would close it without explanation.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    log(`${ev}: ${err.stack ?? err.message}`);
    status = `error: ${err.message}`;
    drawStatus();
  });
}

out.on("resize", () => {
  log(`resize ${cols()}x${rows()}`);
  if (picker) drawPicker();
  else if (vw) relayout(vw, vh);
  drawStatus();
});

// ---- boot ----
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (d: Buffer) => parser.feed(d));
log(`image: ${doubleBuffer ? "double-buffered ids" : "single id (herdr)"}, RGBA`);
// Check that the terminal accepts temp-file transfer (t=t); if it answers with
// an error, frames fall back to inline transfer (see the "kitty" input case).
const probeTmp = join(frameDir, "tty-graphics-protocol-probe.rgb");
writeFileSync(probeTmp, Buffer.from([255, 0, 0]), { flag: "wx" });
write(term.enter + term.queries +
  `\x1b_Gi=34,s=1,v=1,a=q,t=t,f=24;${Buffer.from(probeTmp).toString("base64")}\x1b\\`);
log(`pane ${cols()}x${rows()} cells; TERM=${process.env.TERM} pane=${process.env.HERDR_PANE_ID ?? "-"}`);
drawStatus();
// Give the terminal a moment to answer the size/graphics queries before sizing the stream.
await Bun.sleep(300);
log(`geometry: cell ${cellSize().map((n) => n.toFixed(1)).join("x")} px, kitty=${kittyOk}`);
if (kittyOk === false) {
  status = "terminal reported no Kitty graphics support";
  drawStatus();
}
void startSession();
