#!/usr/bin/env python3
"""Whole-line replacements by line number: nos-lines.py BATCH.json, BATCH.json = {"repo/path": {"12": "new line", ...}}.
A value of null deletes the line. A value may contain "\n" to split one line into several.
Lines are numbered as in `grep -n` (1-based), all relative to the file before this batch."""
import json, os, sys

root = os.path.expanduser("~/nos_brainers")
batch = json.load(open(sys.argv[1], encoding="utf-8"))
for rel, repl in batch.items():
    path = os.path.join(root, rel)
    lines = open(path, encoding="utf-8").read().split("\n")
    for k in sorted(repl, key=int, reverse=True):
        i = int(k) - 1
        if i < 0 or i >= len(lines):
            print(f"line {k} out of range in {rel}")
            sys.exit(1)
        v = repl[k]
        if v is None:
            del lines[i]
        else:
            lines[i:i + 1] = v.split("\n")
    open(path, "w", encoding="utf-8").write("\n".join(lines))
print(f"done: {len(batch)} files")
