"""SCRAM-SHA-256 proof must match the RFC 7677 test vector (checks the Haystack login math)."""
import base64, hashlib, hmac, sys
user, pw, cnonce = "user", "pencil", "rOprNGfwEbeRWgbNEkqO"
s1 = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
f = dict(x.split("=", 1) for x in s1.split(","))
salted = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(f["s"]), int(f["i"]))
ckey = hmac.new(salted, b"Client Key", "sha256").digest()
c1_bare = f"n={user},r={cnonce}"
c2_wo = f"c=biws,r={f['r']}"
amsg = f"{c1_bare},{s1},{c2_wo}".encode()
proof = bytes(a ^ b for a, b in zip(ckey, hmac.new(hashlib.sha256(ckey).digest(), amsg, "sha256").digest()))
sig = hmac.new(hmac.new(salted, b"Server Key", "sha256").digest(), amsg, "sha256").digest()
ok = base64.b64encode(proof).decode() == "dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=" and \
     base64.b64encode(sig).decode() == "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4="
print("SCRAM vector", "ok" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
