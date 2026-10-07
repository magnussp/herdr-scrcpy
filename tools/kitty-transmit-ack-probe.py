# Usage (inside the terminal under test): python3 kitty-transmit-ack-probe.py out.txt
# Sends a=t (file + inline, q=0) and a=q, and records whether the terminal replies.
import os, sys, base64, termios, tty, select, time
out = sys.argv[1]
fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)
def b64(s): return base64.b64encode(s.encode()).decode()
p = '/var/tmp/scrcpy-wezterm-test/img.rgba'
os.makedirs(os.path.dirname(p), exist_ok=True)
open(p, 'wb').write(bytes([255, 0, 0, 255]) * 4)
cmds = [
  f"\x1b_Ga=t,t=f,f=32,s=2,v=2,i=901,q=0;{b64(p)}\x1b\\",          # what herdr sends (file, RGBA)
  f"\x1b_Ga=q,t=f,f=32,s=2,v=2,i=902;{b64(p)}\x1b\\",              # query form
  "\x1b_Ga=t,t=d,f=32,s=1,v=1,i=903,q=0;/wAA/w==\x1b\\",           # inline control
]
res = []
for c in cmds:
    t0 = time.time(); os.write(1, c.encode()); buf = b''
    while time.time() - t0 < 2:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            buf += os.read(fd, 4096)
            if b'\x1b\\' in buf: break
    res.append(f"{c[3:40]!r} -> {buf!r} in {int((time.time()-t0)*1000)}ms")
termios.tcsetattr(fd, termios.TCSADRAIN, old)
open(out, 'w').write("\n".join(res) + "\n")
