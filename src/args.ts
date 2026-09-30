/**
 * Skill argument interpolation and shell substitution.
 *
 * Intercepts `/skill:<name> <args>` at the `input` hook — which Pi runs
 * before its own `_expandSkillCommand` — and emits the same wrapper Pi would.
 * Pipeline:
 *   strip frontmatter → $N/$ARGUMENTS substitution
 *   → ${SKILL_DIR}/${SESSION_ID} substitution
 *   → shell execution (```! blocks, then !`cmd` inlines)
 *   → wrap in <skill name=… location=…>…</skill>, append raw args
 *
 * The emitted text is byte-compatible with Pi's native expansion (see
 * `_expandSkillCommand` and `parseSkillBlock` in
 * dist/core/agent-session.js), so the system prompt is never touched and a
 * skill without placeholders or shell syntax expands exactly as without
 * this extension.
 *
 * Derived from @juicesharp/rpiv-args (MIT).
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  type InputEvent,
  type InputEventResult,
  parseFrontmatter,
  stripFrontmatter,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

const SKILL_PREFIX = "/skill:";

/** Re-entrancy guard: text already wrapped by us or another extension. */
const WRAPPED_PREFIX = "<skill ";

/** Frontmatter `shell-timeout` (seconds) overrides; `0` disables. */
const DEFAULT_SHELL_TIMEOUT_MS = 120_000;

/** Inline shell: !`command`. Single-line, at least one char, so a literal
 *  !`` in prose is left alone. /g — only use with matchAll(). */
const SHELL_INLINE_PATTERN = /!`([^`\n]+)`/g;

/** Block shell: ```!\n…\n```. Content runs as a single program.
 *  /g — only use with matchAll(). */
const SHELL_BLOCK_PATTERN = /```!\n([\s\S]*?)\n```/g;

// ---------------------------------------------------------------------------
// Arguments — same semantics as Pi's prompt templates (parseCommandArgs /
// substituteArgs in dist/core/prompt-templates.js).
// ---------------------------------------------------------------------------

export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/** Order matters: $N, then ${@:N[:L]}, then $ARGUMENTS, then $@. */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num) => args[parseInt(num, 10) - 1] ?? "");
  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    const start = Math.max(0, parseInt(startStr, 10) - 1);
    if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
    return args.slice(start).join(" ");
  });
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}

/** ${SKILL_DIR} is forward-slash-normalized on Windows only, so a POSIX path
 *  containing a literal backslash is preserved. */
export function substituteVariables(
  body: string,
  vars: { skillDir: string; sessionId: string },
): string {
  const skillDir =
    process.platform === "win32" ? vars.skillDir.split("\\").join("/") : vars.skillDir;
  return body
    .replace(/\$\{SKILL_DIR\}/g, skillDir)
    .replace(/\$\{SESSION_ID\}/g, vars.sessionId);
}

// ---------------------------------------------------------------------------
// Shell execution
// ---------------------------------------------------------------------------

/** YAML may yield any scalar. Non-finite values are rejected: NaN would
 *  silently disable pi.exec's timer, and setTimeout(Infinity) fires after
 *  1ms. `0` is an explicit disable. */
export function resolveShellTimeoutMs(frontmatter: { "shell-timeout"?: unknown }): number {
  const raw = frontmatter["shell-timeout"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  return raw * 1000;
}

/** Tail-truncate to Pi's tool output budget, with a footer when cut. */
function truncateForLLM(content: string): string {
  const trunc = truncateTail(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!trunc.truncated) return trunc.content;
  const limit =
    trunc.truncatedBy === "lines" ? `${trunc.maxLines} lines` : formatSize(trunc.maxBytes);
  return `${trunc.content}\n[truncated: hit ${limit}]`;
}

function formatShellOutput(res: ExecResult): string {
  let combined = res.stdout;
  if (res.stderr) {
    const sep = combined.length === 0 || combined.endsWith("\n") ? "" : "\n";
    combined = `${combined}${sep}[stderr]\n${res.stderr}`;
  }
  return truncateForLLM(combined);
}

/** pi.exec never rejects and spawns without a shell, hence the shim. */
async function runOneShellCommand(
  command: string,
  pi: ExtensionAPI,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const [shCmd, shFlag] =
    process.platform === "win32" ? ["powershell.exe", "-Command"] : ["sh", "-c"];
  const res = await pi.exec(shCmd, [shFlag, command], { cwd, timeout: timeoutMs });
  // `killed` first: a timed-out child may also report a non-zero code.
  if (res.killed) {
    const sec = Math.max(1, Math.round(timeoutMs / 1000));
    return `[Shell error: timed out after ${sec}s]`;
  }
  if (res.code !== 0) {
    return `[Shell error: exit code ${res.code}]\n${truncateForLLM(res.stderr)}`;
  }
  return formatShellOutput(res);
}

/**
 * Runs blocks first, then inlines, sequentially (authors rely on ordering).
 * Block matches are replaced with backtick-free sentinels before the inline
 * pass, so neither a !`…` inside a block nor one printed by a block's output
 * is ever executed by the inline pass.
 */
export async function executeShellInBody(
  body: string,
  pi: ExtensionAPI,
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  const blockOutputs: string[] = [];
  let withSentinels = "";
  let last = 0;
  for (const m of body.matchAll(SHELL_BLOCK_PATTERN)) {
    withSentinels += body.slice(last, m.index);
    withSentinels += `\x00BLOCK${blockOutputs.length}\x00`;
    blockOutputs.push(await runOneShellCommand(m[1] ?? "", pi, cwd, timeoutMs));
    last = m.index + m[0].length;
  }
  withSentinels += body.slice(last);

  let withInlines = "";
  last = 0;
  for (const m of withSentinels.matchAll(SHELL_INLINE_PATTERN)) {
    withInlines += withSentinels.slice(last, m.index);
    // Inline output sits mid-sentence: drop one trailing newline, like $(…).
    const output = await runOneShellCommand(m[1] ?? "", pi, cwd, timeoutMs);
    withInlines += output.endsWith("\n") ? output.slice(0, -1) : output;
    last = m.index + m[0].length;
  }
  withInlines += withSentinels.slice(last);

  return withInlines.replace(
    /\x00BLOCK(\d+)\x00/g,
    (_, n) => blockOutputs[parseInt(n, 10)] ?? "",
  );
}

// ---------------------------------------------------------------------------
// Skill index — built lazily from Pi's command registry, so skills shipped by
// other packages' `pi.skills` manifests are recognised too.
// ---------------------------------------------------------------------------

interface SkillIndexEntry {
  readonly name: string;
  readonly filePath: string;
  readonly baseDir: string;
}

let skillIndex: Map<string, SkillIndexEntry> | null = null;

export function invalidateSkillIndex(): void {
  skillIndex = null;
}

function getSkillIndex(pi: ExtensionAPI): Map<string, SkillIndexEntry> {
  if (skillIndex) return skillIndex;
  skillIndex = new Map();
  for (const cmd of pi.getCommands()) {
    if (cmd.source !== "skill") continue;
    const name = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
    const filePath = cmd.sourceInfo.path;
    // Not `cmd.sourceInfo.baseDir`: for manifest-sourced skills that is the
    // package root. Pi's own Skill.baseDir is dirname(filePath).
    skillIndex.set(name, { name, filePath, baseDir: dirname(filePath) });
  }
  return skillIndex;
}

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

/** Byte-identical to Pi's `_expandSkillCommand` output; `parseSkillBlock`
 *  depends on this exact shape. */
function buildSkillMessage(entry: SkillIndexEntry, body: string, args: string): string {
  const block = `<skill name="${entry.name}" location="${entry.filePath}">\nReferences are relative to ${entry.baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

export async function handleInput(
  event: InputEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<InputEventResult> {
  const text = event.text;
  if (text.startsWith(WRAPPED_PREFIX) || !text.startsWith(SKILL_PREFIX)) {
    return { action: "continue" };
  }

  // Same tokenisation as Pi: first space splits name from args.
  const spaceIndex = text.indexOf(" ");
  const skillName =
    spaceIndex === -1 ? text.slice(SKILL_PREFIX.length) : text.slice(SKILL_PREFIX.length, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

  const entry = getSkillIndex(pi).get(skillName);
  if (!entry) return { action: "continue" };

  let content: string;
  try {
    content = readFileSync(entry.filePath, "utf-8");
  } catch {
    return { action: "continue" }; // let Pi report the error
  }

  const { frontmatter } = parseFrontmatter<{ "shell-timeout"?: unknown }>(content);
  let body = stripFrontmatter(content).trim();
  body = substituteArgs(body, parseCommandArgs(argsString));
  body = substituteVariables(body, {
    skillDir: entry.baseDir,
    sessionId: ctx.sessionManager.getSessionId(),
  });
  body = await executeShellInBody(body, pi, ctx.cwd, resolveShellTimeoutMs(frontmatter));

  return { action: "transform", text: buildSkillMessage(entry, body, argsString) };
}

export function registerArgsHandler(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => handleInput(event, ctx, pi));
  pi.on("session_start", () => invalidateSkillIndex());
}
