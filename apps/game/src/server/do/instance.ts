import { DurableObject } from "cloudflare:workers";
import type { Env } from "../contracts.ts";

// TODO(phase1-instance): implement per contracts.ts (InstanceDO section)
export class InstanceDO extends DurableObject<Env> {}
