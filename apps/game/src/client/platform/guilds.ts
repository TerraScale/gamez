/**
 * GuildApi (wave-B.md §6, routes/guilds.ts). The bodies are the GuildInfo /
 * GuildSummary types; wrapped forms (`{guild}`, `{guilds}`) are accepted too,
 * so the client keeps working while the route shapes settle.
 */
import type { CreateGuildRequest, GuildInfo, GuildSummary } from "@gamez/protocol";
import type { ApiResult, GuildApi } from "@gamez/ui-host";
import { badResponse, type HttpClient, unwrap } from "./http.ts";

function isGuild(v: unknown): v is GuildInfo {
  return !!v && typeof v === "object" && typeof (v as GuildInfo).id === "string";
}

/** Passes a guild through, or reports a bad body. */
function guildResult(res: ApiResult<unknown>, what: string, key = "guild"): ApiResult<GuildInfo> {
  if (!res.ok) return res;
  const guild = unwrap(res.value, key);
  return isGuild(guild) ? { ok: true, value: guild } : badResponse(what);
}

export function createGuildApi(http: HttpClient): GuildApi {
  return {
    async mine(): Promise<ApiResult<GuildInfo | null>> {
      const res = await http.request<unknown>({ method: "GET", path: "/api/guilds/mine" });
      if (!res.ok) return res;
      const body = unwrap(res.value, "guild");
      if (body === null || body === undefined) return { ok: true, value: null };
      return isGuild(body) ? { ok: true, value: body } : badResponse("/api/guilds/mine");
    },

    async list(query?: string): Promise<ApiResult<GuildSummary[]>> {
      const q = query?.trim();
      const res = await http.request<unknown>({
        method: "GET",
        path: "/api/guilds",
        query: { q: q ? q : undefined },
      });
      if (!res.ok) return res;
      const list = unwrap(res.value, "guilds");
      return Array.isArray(list)
        ? { ok: true, value: list as GuildSummary[] }
        : badResponse("/api/guilds");
    },

    get(id: string): Promise<ApiResult<GuildInfo>> {
      return http
        .request<unknown>({ method: "GET", path: `/api/guilds/${encodeURIComponent(id)}` })
        .then((res) => guildResult(res, "/api/guilds/:id"));
    },

    create(req: CreateGuildRequest): Promise<ApiResult<GuildInfo>> {
      return http
        .request<unknown>({ method: "POST", path: "/api/guilds", body: req })
        .then((res) => guildResult(res, "/api/guilds"));
    },

    join(id: string): Promise<ApiResult<GuildInfo>> {
      return http
        .request<unknown>({
          method: "POST",
          path: `/api/guilds/${encodeURIComponent(id)}/join`,
          body: {},
        })
        .then((res) => guildResult(res, "/api/guilds/:id/join"));
    },

    async leave(): Promise<ApiResult<null>> {
      const res = await http.request<unknown>({
        method: "POST",
        path: "/api/guilds/leave",
        body: {},
      });
      return res.ok ? { ok: true, value: null } : res;
    },

    kick(accountId: string): Promise<ApiResult<GuildInfo>> {
      return http
        .request<unknown>({ method: "POST", path: "/api/guilds/kick", body: { accountId } })
        .then((res) => guildResult(res, "/api/guilds/kick"));
    },
  };
}
