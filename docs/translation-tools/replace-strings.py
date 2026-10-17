#!/usr/bin/env python3
"""Batch exact replacements: nos-trm.py BATCH.json, where BATCH.json is {"path/from/repo": [[old, new], ...], ...}.
Each old string must be present; missing ones are reported (the other replacements are still written)."""
import json, os, sys

root = os.path.expanduser("~/nos_brainers")
batch = json.load(open(sys.argv[1], encoding="utf-8"))
bad = 0
for rel, pairs in batch.items():
    path = os.path.join(root, rel)
    src = open(path, encoding="utf-8").read()
    missing = []
    for old, new in pairs:
        if old not in src:
            missing.append(old)
            continue
        src = src.replace(old, new)
    open(path, "w", encoding="utf-8").write(src)
    if missing:
        bad += 1
        print("MISSING in", rel)
        for m in missing:
            print("   ", m[:140].replace("\n", "\\n"))
print(f"done: {len(batch)} files, {bad} with missing strings")
sys.exit(1 if bad else 0)
