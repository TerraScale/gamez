/**
 * Prints and records the machine the benchmarks ran on (node version, CPU
 * model, cores, memory, kernel). Run with `pnpm --filter @gamez/bench bench:machine`.
 */
import { readFileSync } from "node:fs";
import { cpus, totalmem, release, arch, platform } from "node:os";
import { writeResults } from "./lib.ts";

const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
const model = /model name\s*:\s*(.+)/.exec(cpuinfo)?.[1]?.trim() ?? cpus()[0]?.model ?? "unknown";
const info = {
  node: process.version,
  v8: process.versions.v8,
  cpu: model,
  logicalCores: cpus().length,
  memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  os: `${platform()} ${release()}`,
  arch: arch(),
  recordedAt: new Date().toISOString(),
};

console.log("### Machine\n");
for (const [k, v] of Object.entries(info)) console.log(`- ${k}: ${v}`);
writeResults("machine", info);
