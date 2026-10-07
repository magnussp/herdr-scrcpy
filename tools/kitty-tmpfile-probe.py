# Usage (inside the terminal under test): python3 kitty-tmpfile-probe.py out.txt
# Sends a=q and a=t with t=t temp files in /tmp, /private/tmp and $TMPDIR; records replies and deletion.
import os, sys, base64, termios, tty, select, time
out = sys.argv[1]
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
os.makedirs('/tmp/scrcpy-probe-dir', exist_ok=True)
tmpdir = os.environ.get('TMPDIR', '/tmp')
paths = {
  'slash-tmp': '/tmp/scrcpy-probe-dir/tty-graphics-protocol-a',
  'private-tmp': '/private/tmp/scrcpy-probe-dir/tty-graphics-protocol-b',
  'TMPDIR': os.path.join(tmpdir, 'tty-graphics-protocol-c'),
}
res = [f"TMPDIR={tmpdir} TERM_PROGRAM={os.environ.get('TERM_PROGRAM')} {os.environ.get('TERM_PROGRAM_VERSION')}"]
for i, (name, p) in enumerate(paths.items()):
    open(p, 'wb').write(bytes([255, 0, 0, 255]))
    for action in ('q', 't'):
        if not os.path.exists(p): open(p, 'wb').write(bytes([255, 0, 0, 255]))
        b = base64.b64encode(p.encode()).decode()
        img = 700 + i * 2 + (action == 't')
        os.write(1, f"\x1b_Ga={action},t=t,f=32,s=1,v=1,i={img};{b}\x1b\\".encode())
        t0 = time.time(); buf = b''
        while time.time() - t0 < 1.5:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                buf += os.read(fd, 4096)
                if b'\x1b\\' in buf: break
        time.sleep(0.2)
        res.append(f"{name:12} a={action}: reply={buf!r} file_deleted={not os.path.exists(p)}")
termios.tcsetattr(fd, termios.TCSADRAIN, old)
open(out, 'w').write("\n".join(res) + "\n")
