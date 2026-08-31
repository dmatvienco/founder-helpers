import { resetPmSession } from "../core/pm-session.js";
import { statePaths } from "../state/paths.js";

/**
 * `fh session reset` — the PM calls this itself in the same run when the
 * founder clearly asks to start fresh ("новая сессия", "забудь", ...); the
 * next reply-mode run then resumes nothing.
 */
export async function sessionCommand(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub !== "reset") {
    console.error("Usage: fh session reset");
    return 1;
  }
  const sp = statePaths(process.cwd());
  resetPmSession(sp.pmSessionFile);
  console.log("PM session reset — the next reply starts a clean conversation.");
  return 0;
}
