/** Worker-thread host of one BotPool; the swarm talks to it with WorkerCommand messages. */
import { parentPort, workerData } from "node:worker_threads";
import type { BotOptions } from "./bot.ts";
import { BotPool } from "./pool.ts";

export type WorkerCommand =
  | { id: number; cmd: "grow"; count: number }
  | { id: number; cmd: "reset" }
  | { id: number; cmd: "report" }
  | { id: number; cmd: "stop" };

const { opts, concurrency } = workerData as { opts: BotOptions; concurrency: number };
const pool = new BotPool(opts, concurrency);
const port = parentPort!;

port.on("message", (msg: WorkerCommand) => {
  void (async () => {
    switch (msg.cmd) {
      case "grow":
        return pool.grow(msg.count);
      case "reset":
        return pool.reset();
      case "report":
        return pool.report();
      case "stop":
        return pool.stop();
    }
  })().then(
    (result) => port.postMessage({ id: msg.id, ok: true, result }),
    (err: unknown) => port.postMessage({ id: msg.id, ok: false, error: String(err) }),
  );
});
