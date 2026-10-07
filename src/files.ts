// Files the mirror owns at runtime: a private directory for frame files and a
// size-capped log.
import { appendFileSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Kitty's temp-file medium (t=t) only accepts paths that contain this marker
// and live in a temp directory, so frames go to a directory named with it.
const FRAME_DIR_PREFIX = "tty-graphics-protocol-scrcpy-";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes frame directories (and files from older versions) left behind by mirrors that are gone. */
function sweepStaleFrameDirs() {
  const uid = process.getuid?.();
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(FRAME_DIR_PREFIX)) continue;
    const pid = Number(name.slice(FRAME_DIR_PREFIX.length).split("-")[0]);
    if (!pid || pid === process.pid || isAlive(pid)) continue;
    const path = join(tmpdir(), name);
    try {
      if (uid !== undefined && statSync(path).uid !== uid) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Creates this process's private frame directory (mode 0700 via mkdtemp) in
 * the temp directory. Nobody else can create or swap files in it, which the
 * shared /tmp on Linux does not guarantee.
 */
export function createFrameDir(): string {
  sweepStaleFrameDirs();
  return mkdtempSync(join(tmpdir(), `${FRAME_DIR_PREFIX}${process.pid}-`));
}

const MAX_LOG_BYTES = 1024 * 1024;

/** Appends timestamped lines to `path`, keeping one rotated copy (`.1`) once it exceeds 1 MiB. */
export function createLogger(path: string): (msg: string) => void {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`);
  } catch {}
  const t0 = performance.now();
  return (msg) =>
    appendFileSync(path, `${new Date().toISOString()} +${((performance.now() - t0) / 1000).toFixed(2)}s ${msg}\n`);
}
