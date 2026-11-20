# Hjelper for konfliktløsning i rehearsal-worktreen. Kun lokalt.
import re

PAT = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)

def resolve(path, fn):
    """fn(i, ours, theirs) -> ny tekst for konfliktområde nr. i (0-indeksert). Returnerer antall områder."""
    s = open(path, encoding="utf-8").read()
    n = [0]
    def repl(m):
        i = n[0]; n[0] += 1
        return fn(i, m.group(1), m.group(2))
    out = PAT.sub(repl, s)
    assert "<<<<<<<" not in out and ">>>>>>>" not in out, f"gjenstående markører i {path}"
    open(path, "w", encoding="utf-8").write(out)
    return n[0]

def union(ours, theirs):
    return ours + theirs
