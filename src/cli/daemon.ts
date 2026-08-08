import { startDaemon } from "../core/daemon.js";

export async function daemonCommand(_args: string[]): Promise<number> {
  let handle;
  try {
    handle = await startDaemon(process.cwd());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log("founder-helpers daemon running (Ctrl+C to stop).");
  console.log(`state: ${handle.paths.root}`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      console.log("\nstopping...");
      void handle.stop().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  return 0;
}
