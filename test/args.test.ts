import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import {
  executeShellInBody,
  handleInput,
  invalidateSkillIndex,
  parseCommandArgs,
  registerArgsHandler,
  resolveShellTimeoutMs,
  substituteArgs,
  substituteVariables,
} from "../src/args.js";

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

const ok = (stdout: string, stderr = ""): ExecResult => ({ stdout, stderr, code: 0, killed: false });

/** Echoes the shell program back as stdout, recording each call. */
function echoExec(calls: string[]): ExecFn {
  return async (_cmd, args) => {
    calls.push(args[1] ?? "");
    return ok(`<${args[1]}>`);
  };
}

function mockPi(skills: Array<{ name: string; filePath: string }>, exec: ExecFn = echoExec([])) {
  const handlers: Record<string, unknown> = {};
  const pi = {
    getCommands: () =>
      skills.map((s) => ({
        name: `skill:${s.name}`,
        source: "skill",
        sourceInfo: { path: s.filePath, baseDir: "/package/root" },
      })),
    exec,
    on: (name: string, handler: unknown) => {
      handlers[name] = handler;
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

const ctx = {
  cwd: "/work",
  sessionManager: { getSessionId: () => "sess-1" },
} as unknown as ExtensionContext;

const input = (text: string): InputEvent => ({ type: "input", text, source: "interactive" });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-skill-args-"));
  invalidateSkillIndex();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSkill(name: string, content: string): { name: string; filePath: string } {
  const filePath = join(dir, `${name}.md`);
  writeFileSync(filePath, content);
  return { name, filePath };
}

describe("parseCommandArgs", () => {
  test("splits on spaces and tabs, collapsing runs", () => {
    assert.deepEqual(parseCommandArgs("a  b\tc"), ["a", "b", "c"]);
  });
  test("keeps quoted groups", () => {
    assert.deepEqual(parseCommandArgs(`a "b c" 'd e'f`), ["a", "b c", "d ef"]);
  });
  test("empty input yields no args", () => {
    assert.deepEqual(parseCommandArgs("   "), []);
  });
});

describe("substituteArgs", () => {
  const args = ["one", "two", "three"];
  test("positional, missing positional empty", () => {
    assert.equal(substituteArgs("$1-$3-$4", args), "one-three-");
  });
  test("slices", () => {
    assert.equal(substituteArgs("${@:2}|${@:1:2}|${@:0}", args), "two three|one two|one two three");
  });
  test("$ARGUMENTS and $@", () => {
    assert.equal(substituteArgs("$ARGUMENTS / $@", args), "one two three / one two three");
  });
  test("no placeholders is a no-op", () => {
    assert.equal(substituteArgs("plain $ text", args), "plain $ text");
  });
});

describe("substituteVariables", () => {
  test("replaces SKILL_DIR and SESSION_ID, leaves unknowns", () => {
    assert.equal(
      substituteVariables("${SKILL_DIR}/x ${SESSION_ID} ${FOO}", { skillDir: "/s", sessionId: "id" }),
      "/s/x id ${FOO}",
    );
  });
});

describe("resolveShellTimeoutMs", () => {
  test("default, seconds, disable, and invalid values", () => {
    assert.equal(resolveShellTimeoutMs({}), 120_000);
    assert.equal(resolveShellTimeoutMs({ "shell-timeout": 5 }), 5000);
    assert.equal(resolveShellTimeoutMs({ "shell-timeout": 0 }), 0);
    for (const bad of ["5", -1, Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      assert.equal(resolveShellTimeoutMs({ "shell-timeout": bad }), 120_000);
    }
  });
});

describe("executeShellInBody", () => {
  test("runs blocks then inlines, sequentially, with cwd and timeout", async () => {
    const calls: string[] = [];
    let opts: unknown;
    const exec: ExecFn = async (_c, args, o) => {
      opts = o;
      calls.push(args[1] ?? "");
      return ok(`<${args[1]}>`);
    };
    const { pi } = mockPi([], exec);
    const out = await executeShellInBody("a !`x` b\n```!\ny\n```\nc !`z`", pi, "/w", 7);
    assert.deepEqual(calls, ["y", "x", "z"]);
    assert.equal(out, "a <x> b\n<y>\nc <z>");
    assert.deepEqual(opts, { cwd: "/w", timeout: 7 });
  });

  test("inline syntax inside a block or its output is not re-executed", async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (_c, args) => {
      calls.push(args[1] ?? "");
      return ok("printed !`evil`");
    };
    const { pi } = mockPi([], exec);
    const out = await executeShellInBody("```!\necho !`nested`\n```", pi, "/w", 1000);
    assert.deepEqual(calls, ["echo !`nested`"]);
    assert.equal(out, "printed !`evil`");
  });

  test("inline output drops one trailing newline, block output keeps it", async () => {
    const { pi } = mockPi([], async () => ok("x\n\n"));
    assert.equal(await executeShellInBody("a !`i` b", pi, "/w", 1000), "a x\n b");
    assert.equal(await executeShellInBody("```!\nb\n```", pi, "/w", 1000), "x\n\n");
  });

  test("empty !`` is left alone", async () => {
    const calls: string[] = [];
    const { pi } = mockPi([], echoExec(calls));
    assert.equal(await executeShellInBody("literal !`` here", pi, "/w", 1000), "literal !`` here");
    assert.deepEqual(calls, []);
  });

  test("stderr, non-zero exit, and timeout formatting", async () => {
    const results: ExecResult[] = [
      ok("out", "warn"),
      { stdout: "", stderr: "boom", code: 2, killed: false },
      { stdout: "", stderr: "", code: 1, killed: true },
    ];
    const { pi } = mockPi([], async () => results.shift()!);
    const out = await executeShellInBody("!`a`|!`b`|!`c`", pi, "/w", 500);
    assert.equal(out, "out\n[stderr]\nwarn|[Shell error: exit code 2]\nboom|[Shell error: timed out after 1s]");
  });
});

describe("handleInput", () => {
  test("passes through non-skill, wrapped, and unknown input", async () => {
    const { pi } = mockPi([]);
    for (const text of ["hello", '<skill name="x">', "/skill:nope a"]) {
      assert.deepEqual(await handleInput(input(text), ctx, pi), { action: "continue" });
    }
  });

  test("passes through when the skill file is unreadable", async () => {
    const { pi } = mockPi([{ name: "gone", filePath: join(dir, "missing.md") }]);
    assert.deepEqual(await handleInput(input("/skill:gone"), ctx, pi), { action: "continue" });
  });

  test("plain skill emits exactly Pi's native expansion", async () => {
    const skill = writeSkill("plain", "---\ndescription: d\n---\n\nDo the thing.\n");
    const { pi } = mockPi([skill]);
    const res = await handleInput(input("/skill:plain some args"), ctx, pi);
    assert.deepEqual(res, {
      action: "transform",
      text: `<skill name="plain" location="${skill.filePath}">\nReferences are relative to ${dir}.\n\nDo the thing.\n</skill>\n\nsome args`,
    });
  });

  test("substitutes args, variables and shell, then appends raw args", async () => {
    const skill = writeSkill(
      "full",
      "---\nshell-timeout: 3\n---\nTarget: $1 ($ARGUMENTS)\nDir: ${SKILL_DIR}\nId: ${SESSION_ID}\nBranch: !`git branch --show-current`\n",
    );
    const calls: string[] = [];
    let opts: unknown;
    const { pi } = mockPi([skill], async (_c, args, o) => {
      opts = o;
      calls.push(args[1] ?? "");
      return ok("main");
    });
    const res = await handleInput(input('/skill:full "a b" c'), ctx, pi);
    assert.equal(res.action, "transform");
    assert.equal(
      (res as { text: string }).text,
      `<skill name="full" location="${skill.filePath}">\nReferences are relative to ${dir}.\n\nTarget: a b (a b c)\nDir: ${dir}\nId: sess-1\nBranch: main\n</skill>\n\n"a b" c`,
    );
    assert.deepEqual(calls, ["git branch --show-current"]);
    assert.deepEqual(opts, { cwd: "/work", timeout: 3000 });
  });

  test("no args: no trailer, placeholders emptied", async () => {
    const skill = writeSkill("noargs", "Input: [$ARGUMENTS]");
    const { pi } = mockPi([skill]);
    const res = await handleInput(input("/skill:noargs"), ctx, pi);
    assert.ok((res as { text: string }).text.endsWith("Input: []\n</skill>"));
  });
});

describe("registerArgsHandler", () => {
  test("registers only input and session_start (no system prompt hook)", () => {
    const { pi, handlers } = mockPi([]);
    registerArgsHandler(pi);
    assert.deepEqual(Object.keys(handlers).sort(), ["input", "session_start"]);
  });

  test("session_start invalidates the skill index", async () => {
    const skills: Array<{ name: string; filePath: string }> = [];
    const { pi, handlers } = mockPi(skills);
    registerArgsHandler(pi);
    assert.deepEqual(await handleInput(input("/skill:late"), ctx, pi), { action: "continue" });
    skills.push(writeSkill("late", "Hi"));
    (handlers.session_start as () => void)();
    assert.equal((await handleInput(input("/skill:late"), ctx, pi)).action, "transform");
  });
});
