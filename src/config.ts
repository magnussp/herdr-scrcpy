import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface Config {
  /** adb serial to always mirror; empty = the only connected phone, or a picker when several are connected */
  serial: string;
  /** Long side of the video in px. Further capped by the pane's pixel height. */
  max_size: number;
  /** Upper bound for both the device encoder and the terminal redraw loop. */
  max_fps: number;
  video_bit_rate: number;
  /** Path to scrcpy-server; empty = auto-detect next to the scrcpy binary. */
  server_path: string;
  /** Must match the server exactly; empty = parse `scrcpy --version`. */
  server_version: string;
  /** "file" = raw frames via temp files (fast, local only); "direct" = zlib+base64 inline. */
  transfer: "file" | "direct";
  /**
   * Upper bound on raw image data sent to the terminal, in MB/s (0 = unlimited).
   * herdr queues every frame it can't keep up with instead of dropping old ones,
   * so going over its throughput (~32 MB/s measured with Ghostty) makes the lag
   * grow without bound and stalls all panes. The frame rate is capped to
   * stay under this budget: fps <= budget / (width * height * 4).
   */
  max_mb_per_sec: number;
}

const DEFAULTS: Config = {
  serial: "",
  max_size: 1280,
  max_fps: 30,
  video_bit_rate: 4_000_000,
  server_path: "",
  server_version: "",
  transfer: "file",
  max_mb_per_sec: 16,
};

const TEMPLATE = `# herdr scrcpy plugin config
# serial = ""             # adb serial to always mirror; empty = the only phone, or a picker when several
max_size = ${DEFAULTS.max_size}            # long side of the video in px (also capped by pane height)
max_fps = ${DEFAULTS.max_fps}              # upper bound; the phone is asked for less if max_mb_per_sec requires it
video_bit_rate = ${DEFAULTS.video_bit_rate}
# server_path = ""        # empty = auto-detect scrcpy-server
# server_version = ""     # empty = from \`scrcpy --version\`
# transfer = "file"       # "file" (temp files, fastest) or "direct" (inline, works over ssh)
max_mb_per_sec = 16       # raw image budget, fps is capped to fit. 16 is safe anywhere; ~120 with the Ghostty fast path (README)
`;

export function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR ?? join(import.meta.dir, "..", ".dev", "config");
}

export function stateDir(): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(import.meta.dir, "..", ".dev", "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(): Config {
  const path = join(configDir(), "config.toml");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, TEMPLATE);
  }
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Partial<Config>;
  return { ...DEFAULTS, ...parsed };
}

export function resolveServer(cfg: Config): { path: string; version: string } {
  let path = cfg.server_path;
  if (!path) {
    const bin = Bun.which("scrcpy");
    const candidates = [
      process.env.SCRCPY_SERVER_PATH,
      bin && join(dirname(bin), "..", "share", "scrcpy", "scrcpy-server"),
      "/opt/homebrew/share/scrcpy/scrcpy-server",
      "/usr/local/share/scrcpy/scrcpy-server",
      "/usr/share/scrcpy/scrcpy-server",
    ].filter(Boolean) as string[];
    path = candidates.find((p) => existsSync(p)) ?? "";
    if (!path) throw new Error("scrcpy-server not found; install scrcpy or set server_path in config.toml");
  } else if (!existsSync(path)) {
    throw new Error(`server_path ${path} does not exist`);
  }
  let version = cfg.server_version;
  if (!version) {
    if (!Bun.which("scrcpy")) throw new Error("scrcpy not found on PATH; install scrcpy or set server_version in config.toml");
    const out = Bun.spawnSync(["scrcpy", "--version"]).stdout.toString();
    const m = out.match(/^scrcpy (\S+)/m);
    if (!m) throw new Error("could not determine scrcpy version; set server_version in config.toml");
    version = m[1];
  }
  return { path, version };
}
