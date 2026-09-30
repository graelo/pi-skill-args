# pi-skill-args

A Pi extension that brings Claude Code-style argument placeholders and inline
shell commands to Pi skills.

Forked from [`@juicesharp/rpiv-args`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-args),
keeping only the expansion logic. Unlike upstream, it **never modifies the
system prompt**: no `before_agent_start` hook, no "skill invocation protocol"
section. That keeps it compatible with Pi 0.99.2's per-prompt system prompt
sections (e.g. `mcp_servers`) and with prompt caching.

## Syntax

In a skill's `SKILL.md` body:

| Syntax | Expands to |
| --- | --- |
| `$1`, `$2`, … | Positional argument (empty if missing) |
| `$ARGUMENTS`, `$@` | All arguments, space-joined |
| `${@:N}`, `${@:N:L}` | Arguments from position N (L of them) |
| `${SKILL_DIR}` | Directory containing the skill file |
| `${SESSION_ID}` | Current Pi session id |
| `` !`cmd` `` | stdout of `cmd` (single line) |
| ```` ```! ```` … ```` ``` ```` | stdout of the fenced program (multi-line) |

Arguments are tokenised like Pi prompt templates: whitespace-separated, with
`"…"` / `'…'` grouping.

Commands run with `sh -c` (PowerShell on Windows) in the session's working
directory, sequentially, blocks before inlines. Output is tail-truncated to
Pi's tool output budget; stderr is appended under `[stderr]`. Failures render
as `[Shell error: exit code N]` or `[Shell error: timed out after Ns]`.

The default timeout is 120 s. Override it per skill in frontmatter, in
seconds (`0` disables):

```yaml
---
name: review
description: Review the current branch
shell-timeout: 30
---
```

## Example

````markdown
---
name: review
description: Review changes against a base branch
---

Review the diff between `$1` and the current branch.

Current branch: !`git branch --show-current`

```!
git diff --stat $1...HEAD
```
````

Invoked as `/skill:review main`.

## How it works

Pi runs extension `input` handlers before its own `/skill:` expansion. This
extension intercepts `/skill:<name> <args>`, reads the skill file, applies the
substitutions above, and returns the same `<skill name=… location=…>` wrapper
Pi would produce, followed by the raw arguments. Pi then sees already-expanded
text and leaves it alone.

A skill without placeholders or shell syntax expands byte-identically to Pi's
native behaviour. Skills are looked up through `pi.getCommands()`, so skills
shipped by other packages are covered, and the index is refreshed on every
`session_start`.

## Installation

Place the `pi-skill-args` directory in one of Pi's extension locations, or
reference it from a package manifest via its `pi.extensions` field:

- Project-local: `.pi/extensions/pi-skill-args/`
- Global: `~/.pi/agent/extensions/pi-skill-args/`

Then run `/reload` inside pi, or restart.

Quick test without installing:

```bash
pi -e ./src/index.ts
```

Remove `@juicesharp/rpiv-args` if installed: both would intercept the same input.

## Security

Shell commands in a skill run with your privileges as soon as the skill is
invoked. Only install skills you trust.

## Development

```bash
npm run check   # type-check
npm test        # run tests
```

## License

MIT — see [LICENSE](LICENSE). Original work © juicesharp.
