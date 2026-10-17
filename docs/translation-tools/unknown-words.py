#!/usr/bin/env python3
"""Words in TARGET files that never appear in the VOCAB files (already-English code): likely French leftovers.
Usage: .nos-unknown.py VOCAB_DIR[,VOCAB_DIR…] TARGET_DIR_OR_FILE… [--lines]
Prints each unknown word with its count; with --lines, the lines where the rarest ones appear."""
import os, re, sys, subprocess
from collections import Counter

ROOT = os.path.expanduser("~/nos_brainers")
WORD = re.compile(r"[A-Za-zÀ-ÿœŒ]{3,}")
EXT = (".ts", ".tsx", ".mjs", ".js", ".md", ".sh", ".ps1", ".sql", ".yml", ".yaml", ".css", ".example")

def files(p):
    full = os.path.join(ROOT, p)
    if os.path.isfile(full):
        return [p]
    out = subprocess.run(["git", "ls-files", p], cwd=ROOT, capture_output=True, text=True).stdout.split()
    return [f for f in out if f.endswith(EXT) or "Dockerfile" in f]

def words(text):
    # split camelCase / snake identifiers so code tokens join the vocabulary too
    for w in WORD.findall(text):
        for part in re.findall(r"[A-ZÀ-Ý]?[a-zà-ÿœ]+|[A-ZÀ-Ý]+(?![a-zà-ÿ])", w):
            if len(part) >= 3:
                yield part.lower()

args = [a for a in sys.argv[1:] if not a.startswith("--")]
show_lines = "--lines" in sys.argv
vocab = set()
for d in args[0].split(","):
    for f in files(d):
        try:
            vocab.update(words(open(os.path.join(ROOT, f), encoding="utf-8", errors="ignore").read()))
        except OSError:
            pass
counts = Counter()
where = {}
for t in args[1:]:
    for f in files(t):
        for n, line in enumerate(open(os.path.join(ROOT, f), encoding="utf-8", errors="ignore"), 1):
            for w in words(line):
                if w not in vocab:
                    counts[w] += 1
                    where.setdefault(w, []).append(f"{f}:{n}: {line.strip()[:160]}")
for w, c in counts.most_common():
    print(f"{c:4} {w}")
    if show_lines:
        for l in where[w][:3]:
            print("       ", l)
