import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_SPECS,
  GenericCliBackend,
} from "../src/backends/cli.ts";

describe("opencode CLI spec", () => {
  const spec = CLI_SPECS.opencode!;

  test("buildArgs maps catalog ids to pinned zen provider ids", () => {
    expect(spec.buildArgs("fix the test", "glm-5.2")).toEqual([
      "run",
      "--model",
      "opencode/glm-5.2",
      "fix the test",
    ]);
  });

  test("claude-family ids get the zen claude- prefix and preserve high variant", () => {
    expect(spec.buildArgs("fix the test", "opus-5")).toContain(
      "opencode/claude-opus-5",
    );
    expect(spec.buildArgs("fix the test", "fable-5-high")).toContain(
      "opencode/claude-fable-5",
    );
    expect(spec.buildArgs("fix the test", "fable-5-high")).toEqual(
      expect.arrayContaining(["--variant", "high"]),
    );
  });

  test("tier effort is passed through as an opencode variant", () => {
    expect(spec.buildArgs("fix the test", "opus-5", "max")).toEqual(
      expect.arrayContaining(["--variant", "max"]),
    );
  });

  test("unknown ids pass through so users can pin their own provider/model", () => {
    expect(spec.buildArgs("fix the test", "openai/gpt-5.6-sol")).toContain(
      "openai/gpt-5.6-sol",
    );
    expect(spec.buildArgs("fix the test", "some-future-model")).toContain(
      "some-future-model",
    );
  });

  test("read-only lanes use an enforced read-only agent profile", () => {
    const args = spec.buildArgs(
      "audit the change",
      "opus-5",
      undefined,
      "none",
    );
    expect(args).toContain("--pure");
    expect(args).toContain("--agent");
    const agent = args[args.indexOf("--agent") + 1];
    expect(agent).toStartWith("relay-readonly-");
    expect(agent).not.toBe("relay-readonly");

    const inline = spec.buildEnv?.(undefined, "none")
      .OPENCODE_CONFIG_CONTENT;
    expect(inline).toBeTruthy();
    const config = JSON.parse(inline!) as {
      agent?: Record<string, { permission?: Record<string, string> }>;
    };
    expect(config.agent?.[agent!]?.permission?.["*"]).toBe("deny");
    expect(config.agent?.[agent!]?.permission?.read).toBe("allow");
  });

  test("flags are verified against a real install", () => {
    // Verified 2026-07-25 against opencode 1.18.5, live `opencode run`.
    expect(spec.verified).toBe(true);
  });

  test("login uses the providers subcommand and stays interactive", () => {
    expect(spec.loginArgs).toEqual(["providers", "login"]);
    expect(spec.loginInteractive).toBe(true);
  });

  test("missing required flags produce an actionable backend failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-opencode-flags-"));
    const bin = join(dir, "opencode");
    writeFileSync(
      bin,
      "#!/bin/sh\nif [ \"$1\" = run ] && [ \"$2\" = --help ]; then echo --model; fi\nexit 0\n",
      { mode: 0o755 },
    );
    const backend = new GenericCliBackend(spec);
    const result = await backend.run(
      { goal: "fix the test", done_means: [] },
      {
        binary: bin,
        cwd: dir,
        model: "opus-5",
        effort: "high",
        write: "tree",
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("missing required flag");
    expect(result.output).toContain("--variant");
    expect(result.usage?.tokensIn).toBe(0);
  });
});
