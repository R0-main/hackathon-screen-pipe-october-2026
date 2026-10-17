---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance (accessibility, focus, forms, animation, typography, images, performance, navigation, dark mode, i18n). Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Vercel's Web Interface Guidelines.

## How It Works

1. Read the rules in [guidelines.md](guidelines.md) (in this folder).
2. Read the specified files (or ask the user which files or pattern to review).
3. Check them against every rule.
4. Output findings in the terse `file:line` format the guidelines specify.

## Guidelines Source

`guidelines.md` is a copy of `command.md` from https://github.com/vercel-labs/web-interface-guidelines (MIT), vendored
in this repo so a review never runs instructions fetched at review time. To update it, replace the file with the
upstream version and note the commit in `.claude/skill-licenses/README.md`.

In this project, `apps/web/DESIGN.md` wins where a rule conflicts with the chosen art direction.
