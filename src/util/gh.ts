import { execFileSync } from "node:child_process";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable seam for `gh` CLI calls — auth/repo access need a real login and network, neither available in tests. */
export type GhExec = (args: string[], cwd: string) => GhResult;

export const execGh: GhExec = (args, cwd) => {
  try {
    const stdout = execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : "",
      stderr: e.stderr ? String(e.stderr) : err instanceof Error ? err.message : String(err),
    };
  }
};
