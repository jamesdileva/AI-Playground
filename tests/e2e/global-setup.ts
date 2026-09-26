import { rm } from "node:fs/promises";

async function globalSetup(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await rm(`hangout.e2e.db${suffix}`, { force: true });
    } catch {
      return;
    }
  }
}

export default globalSetup;
