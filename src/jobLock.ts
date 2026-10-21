import { closeSync, existsSync, openSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const staleAfterMs = 6 * 60 * 60 * 1000;

export function acquireJobLock(): () => void {
  const lockPath = process.env.SCREEN_LOCK_PATH ?? join(process.cwd(), "data", "screening.lock");

  if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) {
    unlinkSync(lockPath);
  }

  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx");
    writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("A screening job is already running", { cause: error });
    }
    throw error;
  }

  return () => {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  };
}
