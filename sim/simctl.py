"""Send one control command to the running simulator: python3 simctl.py /tmp/sim.sock '{"cmd":"list"}'"""
import json
import socket
import sys


def ctl(path, cmd):
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(30)
    s.connect(path)
    s.sendall((json.dumps(cmd) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(1 << 20)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf)


if __name__ == "__main__":
    print(json.dumps(ctl(sys.argv[1], json.loads(sys.argv[2]))))
