import { fileURLToPath } from "node:url";

/** Repo root, the game app and the workspace `vp` binary (not a global one). */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const GAME_DIR = `${ROOT}apps/game`;
export const MIGRATIONS_DIR = `${GAME_DIR}/migrations`;
export const VP_BIN = `${ROOT}node_modules/.bin/vp`;
