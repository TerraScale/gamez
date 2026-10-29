/**
 * Runs every benchmark in sequence, each in its own node process (the ECS
 * bench needs --expose-gc). Run with `pnpm --filter @gamez/bench bench`.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const steps: { file: string; flags: string[] }[] = [
  { file: "machine.ts", flags: [] },
  { file: "ecs.ts", flags: ["--expose-gc"] },
  { file: "kernel.ts", flags: [] },
  { file: "sync.ts", flags: [] },
  { file: "party.ts", flags: [] },
];

for (const step of steps) {
  console.log(`\n## ${step.file}`);
  execFileSync(
    process.execPath,
    [...step.flags, "--experimental-transform-types", join(here, step.file)],
    { stdio: "inherit" },
  );
}
