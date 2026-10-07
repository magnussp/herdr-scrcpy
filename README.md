# herdr-scrcpy

A [herdr](https://herdr.dev) plugin that mirrors an Android device into a herdr
pane and lets you control it with your mouse and keyboard, using
[scrcpy](https://github.com/Genymobile/scrcpy)'s server and the Kitty graphics
protocol.

```
┌─ claude ─────────────────────┬─ Android ──────────┐
│ > fix the login screen…      │   ┌────────────┐   │
│                              │   │  17:53     │   │
│                              │   │            │   │
│                              │   │  [Sign in] │   │
│                              │   └────────────┘   │
│                              │ Pixel 10 Pro ≤30fps│
└──────────────────────────────┴────────────────────┘
```

> [!IMPORTANT]
> **On macOS, start Ghostty like this, or the mirror will lag by seconds:**
>
> ```sh
> open -na /Applications/Ghostty.app --env TMPDIR=/tmp
> ```
>
> See [Terminal setup](#terminal-setup-important) for why, and for how to keep
> your shells' normal temp directory.

## Requirements

| What | Version | Notes |
|---|---|---|
| herdr | 0.9.3 tested (≥ 0.9.2 needed for fast image transfer) | |
| Terminal | **Ghostty**, launched with the workaround below | WezTerm works but is slow, see [below](#terminal-setup-important) |
| [Bun](https://bun.sh) | 1.x (1.0.2 tested) | runs the plugin and its tests |
| scrcpy | 5.x | only `scrcpy-server` and `scrcpy --version` are used |
| adb | any recent | `brew install android-platform-tools` |
| FFmpeg libraries + `pkg-config` | FFmpeg 9 tested | `brew install ffmpeg pkg-config` |
| C compiler | Xcode Command Line Tools / gcc | builds the native decoder (`scripts/build-native.sh`) |

On the phone, enable **USB debugging** and accept the authorization prompt
(`adb devices` must list it as `device`, not `unauthorized`).

Tested on macOS with a Pixel 10 Pro (Android 17). Linux should work (the
manifest allows it) but is untested.

## Install

From GitHub:

```sh
herdr plugin install magnussp/herdr-scrcpy
```

herdr shows a preview, then runs the manifest's `[[build]]` step
(`scripts/build-native.sh`), which compiles the native decoder. Update later
with `herdr plugin update magnussp.scrcpy`.

From a local checkout (development):

```sh
git clone https://github.com/magnussp/herdr-scrcpy.git ~/src/herdr-scrcpy
cd ~/src/herdr-scrcpy
bun install                   # dev types only; no runtime dependencies
sh scripts/build-native.sh    # builds bin/scrcpy-decode
herdr plugin link "$PWD"
```

`herdr plugin link` skips build steps, so run the script yourself in a linked
checkout, and again after changing `native/decode.c`. If the binary is missing
or older than `native/decode.c` when the mirror starts, the mirror builds a
private copy in its state directory instead of failing.

## Usage

herdr has no command palette; plugin actions run from a key binding or the CLI.
Either way, the mirror opens next to the current pane.

- Key binding (recommended). Add this to `~/.config/herdr/config.toml`, then run
  `herdr server reload-config`. `prefix+m` (default: `Ctrl+B`, then `M`) opens
  the mirror:

  ```toml
  [[keys.command]]
  key = "prefix+m"
  type = "plugin_action"
  command = "magnussp.scrcpy.mirror"
  description = "Mirror Android device"
  ```

- From any herdr pane: `herdr plugin action invoke magnussp.scrcpy.mirror`

With one phone connected, the pane mirrors it right away. With several, it
shows a picker: choose with the arrow keys or `1`–`9` and `Enter`, or click a
phone. Press `Ctrl+D` at any time to switch to another phone. The phone you
picked last is preselected next time. Phones that aren't authorized yet are
listed but can't be chosen until you accept the USB debugging prompt on them.
To always use one phone, set `serial` in the config.

The mirror recovers by itself:
- if the phone disconnects, it shows why and reconnects when the phone is back;
- if the decoder crashes, it restarts;
- if `adb` hangs, it times out (after 10–30 s) instead of freezing the pane;
- if scrcpy's server on the phone fails, its own error message is shown (for
  example a version mismatch);
- setup problems, such as a missing `adb` or `scrcpy`, are shown in the status
  line and retried until fixed.

Repeated failures retry after 2, 4, 8, 16 and then every 30 s, and the status
line says when the next attempt is. The delay resets once a stream works.
Closing the pane stops everything the mirror started: the decoder, `adb` calls
in progress, the server on the phone and its `adb forward`.

### Controls

| Input in the pane | On the phone |
|---|---|
| Left click | Tap |
| Left drag | Swipe |
| Mouse wheel | Scroll |
| Right click, `Esc`, `Ctrl+B` | Back |
| `Ctrl+O` | Home |
| `Ctrl+S` | Recent apps |
| `Ctrl+D` | Choose another phone (picker) |
| Typing | Text input |
| `Enter`, `Backspace`, `Delete`, `Tab`, arrows, `Home`/`End`, `PgUp`/`PgDn` | Matching Android keys |
| `Ctrl+Q` or `Ctrl+C` | Close the mirror |

The bottom line of the pane shows the device, the video size, the frame-rate
cap, the measured fps and throughput.

## Configuration

The config file is created on first run at:

```sh
herdr plugin config-dir magnussp.scrcpy    # → ~/.config/herdr/plugins/config/magnussp.scrcpy/config.toml
```

| Key | Default | Meaning |
|---|---|---|
| `serial` | `""` | adb serial to always mirror. Empty: the only connected phone, or a picker when several are connected. A phone chosen with `Ctrl+D` wins until the pane closes. |
| `max_size` | `1280` | Long side of the video in px. Also capped to the pane's height. |
| `max_fps` | `30` | Upper bound on the frame rate. |
| `max_mb_per_sec` | `16` | Budget for raw image data sent to herdr, in MB/s (`0` = unlimited). The frame rate is lowered to fit: `fps ≤ budget / (width × height × 4)`. |
| `video_bit_rate` | `4000000` | H.264 bit rate on the phone. |
| `transfer` | `"file"` | `"file"`: frames go to herdr as temp files (fast, local only). `"direct"`: inline zlib + base64 (slower; for remote setups). Falls back to `direct` automatically if the terminal refuses files. |
| `server_path` | auto | Path to `scrcpy-server`; auto-detected next to the `scrcpy` binary. |
| `server_version` | auto | Must match the server exactly; read from `scrcpy --version`. |

The frame rate requested from the phone is derived automatically: before
starting, the plugin reads the screen size (`adb shell wm size`), works out the
video size for `max_size`, and asks the encoder for the highest fps that fits
`max_mb_per_sec` (never above `max_fps`). Frames that would be dropped are never
encoded, sent or decoded.

**Recommended settings with the Ghostty workaround in place** (1280 px HD at
30 fps needs about 84 MB/s):

```toml
max_size = 1280
max_fps = 30
max_mb_per_sec = 120
```

Without the workaround, keep `max_mb_per_sec` at about 16 (see below). Close and
reopen the pane after changing the config.

## Terminal setup (important)

herdr doesn't pass images straight through to your terminal: it receives the
frames from the plugin and re-sends them to the terminal it is attached to. How
it re-sends them decides whether the mirror is smooth or lags by seconds.

| Host terminal | How herdr sends images | Measured result |
|---|---|---|
| **Ghostty, launched with `TMPDIR=/tmp`** | temp files | **~0 ms lag** at 572×1280 @ 30 fps and at full 1080×2410 @ 30 fps (~300 MB/s) |
| Ghostty, normal launch (Dock / Finder) | inline base64 | caps at ~32 MB/s; above that the lag grows without bound (10 s+) and every herdr pane stalls |
| WezTerm | inline base64 | same as above, and the herdr client uses ~140% CPU |

### Why Ghostty needs `TMPDIR=/tmp` on macOS

1. herdr writes its image files to `/tmp/herdr-kitty-files-<uid>/…` and only
   switches to file transfer after Ghostty reads and deletes a one-time test
   file.
2. Ghostty resolves the file's real path first; on macOS `/tmp/…` becomes
   `/private/tmp/…`. It then accepts the file only if that path starts with the
   literal `/tmp`, with `/dev/shm`, or with its own `$TMPDIR` (or that
   directory's real path).
3. `/private/tmp/…` never matches the default per-user `$TMPDIR`
   (`/var/folders/…`), so Ghostty answers `EINVAL: temporary file not in temp
   dir`, herdr's test fails, and herdr falls back to base64 for that client for
   good.
4. With Ghostty's own `TMPDIR=/tmp`, the real path of its temp directory is
   `/private/tmp`, so herdr's files are accepted.

This was verified against Ghostty 1.3.1 (the same check is still in Ghostty's
`main` branch) and herdr 0.9.3.

### Setup

1. Start a new Ghostty instance with `TMPDIR=/tmp`. You can run this from any
   terminal, including the Ghostty you already have open:

   ```sh
   open -na /Applications/Ghostty.app --env TMPDIR=/tmp
   ```

2. Run `herdr` in the new window to attach, then close the old Ghostty window.
   herdr tests file transfer once per client attach, so a client attached from
   the old Ghostty keeps using the slow path.

3. Optional but recommended: give shells inside Ghostty their normal per-user
   temp directory back. Add this to
   `~/Library/Application Support/com.mitchellh.ghostty/config.ghostty`, using
   the output of `getconf DARWIN_USER_TEMP_DIR`:

   ```
   env = TMPDIR=/var/folders/xx/xxxxxxxx/T/
   ```

   Ghostty itself keeps `TMPDIR=/tmp`; only the commands it launches get this
   value. Reload the config (Cmd+Shift+,) for new tabs to pick it up.

Side effect: while Ghostty runs with `TMPDIR=/tmp`, it refuses Kitty image temp
files in the per-user temp directory. That only matters for programs run
directly in Ghostty (outside herdr) that send images that way; this plugin
detects it and falls back to inline transfer.

### Checking that the fast path is active

```sh
ls -la /tmp/herdr-kitty-files-$(id -u)/*/
```

A file `tty-graphics-protocol-0` that stays there means Ghostty refused herdr's
test file and herdr is on the slow path. Another sign is the herdr client's
memory growing quickly while the phone screen is busy.

## How it works

```
phone                              plugin pane process                    herdr        terminal
─────                              ───────────────────                    ─────        ────────
scrcpy-server ──H.264 over adb──▶  src/scrcpy.ts  (protocol, control)
  (hardware encoder,               bin/scrcpy-decode (libavcodec, low delay)
   max_size / max_fps)                 └─ RGBA frame → temp file
                                   src/mirror.ts ──Kitty a=T,t=t,f=32──▶  herdr ──file──▶ Ghostty
mouse / keys ◀──control socket───  SGR mouse + keys from the pane ◀─────  herdr ◀─────── you
```

- **scrcpy 5 protocol** (`src/scrcpy.ts`): pushes the installed
  `scrcpy-server`, opens video and control sockets over an `adb forward`
  tunnel, and parses scrcpy 5's framing (session packets carry the size and
  are re-sent on rotation). Audio is off.
- **Native decoder** (`native/decode.c`, built by `scripts/build-native.sh`):
  scrcpy packets are complete frames,
  so they go straight to libavcodec in low-delay mode with no parser. Frames
  come out 1.5–10 ms after their packet; the ffmpeg CLI held one frame back
  (~100 ms) and is not used. Each frame is written as raw RGBA to its own temp
  file, so pixels never pass through a pipe or the JS heap.
- **Drawing** (`src/mirror.ts`, `src/terminal.ts`): a frame is drawn as soon
  as it arrives, capped by `max_fps` and `max_mb_per_sec`; the newest frame
  wins. Inside herdr, one image id is reused (herdr double-buffers itself, and
  changing ids would switch off herdr's fast path); in a plain terminal two ids
  alternate to avoid flicker.
- **Input**: SGR mouse reports are mapped from cells to video pixels and sent
  as touch and scroll events on scrcpy's control socket; text and keys are
  sent as text and Android key codes.

## Development

```sh
bun test                           # unit tests (protocol encoding, input parsing, picker, files)
bun run typecheck                  # tsc with tsconfig.json
bun run build:native               # rebuild bin/scrcpy-decode after changing native/decode.c
bun src/mirror.ts                  # run the mirror in the current terminal (outside herdr)
bun src/probe.ts 5 frame.png       # headless: connect, decode 5 s, report sizes, save a frame
bun src/bench.ts 572 1280 30 20    # synthetic frames with a timestamp, to measure terminal throughput/lag
herdr plugin log list --plugin magnussp.scrcpy
```

Layout:

| Path | What |
|---|---|
| `herdr-plugin.toml` | manifest: build step, the `mirror` action and pane |
| `src/mirror.ts` | pane entrypoint: session lifecycle, drawing, input, picker UI |
| `src/scrcpy.ts` | scrcpy 5 client: server launch, tunnel, video framing, control messages, adb helpers |
| `src/decoder.ts`, `native/decode.c` | native H.264 → RGBA decoder and its wrapper |
| `src/terminal.ts` | input parser and Kitty graphics commands |
| `src/picker.ts` | device choice and the picker's state and rendering |
| `src/config.ts`, `src/files.ts` | config, scrcpy-server lookup, frame directory, log |
| `scripts/` | `build-native.sh` (build step), `open-mirror.sh` (action) |
| `test/` | `bun test` suites |
| `tools/` | terminal probe scripts used to diagnose the herdr/Ghostty/WezTerm issues |

The mirror logs to `~/.local/state/herdr/plugins/magnussp.scrcpy/mirror.log` (rotated to
`mirror.log.1` past 1 MiB). Every 2 s it records decoded and drawn fps,
throughput, and per-stage timings: `net` (adb queueing), `dec` (decode), `wait`
(time until drawn), `enc` (building the Kitty command), `drain` (writing to the
pty). Keyboard input is never logged, since it includes whatever you type into
the phone. Run outside herdr, config and logs go to `.dev/` in the checkout.

Frames are written to a private directory,
`$TMPDIR/tty-graphics-protocol-scrcpy-<pid>-*` (mode 0700). Files in it are
created exclusively and never through symlinks. The directory is removed when
the mirror exits, and directories left by mirrors that died are removed the next
time one starts.

`bench.ts` draws the current time into every frame. Comparing a screenshot of
the pane with the real time gives the true end-to-end lag, which is how the
numbers in this README were measured.

## Known issues and upstream bugs

- **Ghostty (macOS):** Kitty `t=t` temp files are checked by real path against
  the literal `/tmp`, so `/tmp` files are always refused on macOS. That makes
  the `TMPDIR=/tmp` workaround necessary.
- **herdr:** image temp files are hard-coded to `/tmp`, which runs into the
  Ghostty issue above.
- **herdr:** with WezTerm, the file-based path never activates, because WezTerm
  never confirms Kitty uploads (it only answers `a=q` queries).
- **herdr:** when it can't keep up, herdr queues every frame instead of dropping
  superseded ones, so lag and memory grow without bound. `max_mb_per_sec`
  exists to stay below that limit.
- herdr doesn't answer terminal pixel-size queries, so the image's aspect ratio
  inside the pane assumes cells twice as tall as wide.
- The plugin is local only: frames are passed as files, and herdr's fast path
  requires the terminal to be on the same machine.

## Acknowledgements

A big thank you to [Romain Vimont (@rom1v)](https://github.com/rom1v), the
creator and maintainer of [scrcpy](https://github.com/Genymobile/scrcpy), to
Genymobile, where scrcpy started, and to everyone who has contributed to it.
This plugin wouldn't exist without scrcpy. Everything it does on the phone
(capturing the screen, hardware H.264 encoding, injecting touches and keys) is
`scrcpy-server`, and scrcpy's documented protocol and low-latency design made it
possible to build a client for a terminal pane. Thank you for years of
excellent, freely shared work.

Thanks as well to [Can Celik (@ogulcancelik)](https://github.com/ogulcancelik)
and everyone who builds [herdr](https://github.com/herdrdev/herdr). herdr gives
plugins a lot to build on: a simple manifest, the whole CLI as the plugin API,
plugin-owned panes, and native Kitty graphics in panes that this mirror draws
with. Its docs and the
[plugin examples](https://github.com/ogulcancelik/herdr-plugin-examples) made
getting started easy. Thank you for building such a hackable home for terminal
work.

## License

Apache License 2.0, the same as [scrcpy](https://github.com/Genymobile/scrcpy)
and [herdr](https://github.com/herdrdev/herdr). See [LICENSE](LICENSE).

The plugin doesn't bundle scrcpy: it starts the `scrcpy-server` from your own
scrcpy installation on the phone, and speaks its protocol with its own client
code.
