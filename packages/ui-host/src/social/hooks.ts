/** React glue for the social components: channel clients and views, kept out of render paths. */
import { useEffect, useState } from "react";
import type { ChannelId, ChatApi, ChatChannelClient, ChatChannelView } from "../platform.ts";

export const EMPTY_CHAT_VIEW: ChatChannelView = {
  channel: "",
  status: "connecting",
  messages: [],
  mutedUntil: null,
  blocked: [],
  error: null,
};

/**
 * One chat client per channel, opened on mount and closed on unmount (or when
 * the channel list changes). Empty until the effect has run.
 */
export function useChannelClients(
  chat: ChatApi,
  channelIds: readonly ChannelId[],
): ReadonlyMap<ChannelId, ChatChannelClient> {
  const key = channelIds.join("\n");
  const [clients, setClients] = useState<ReadonlyMap<ChannelId, ChatChannelClient>>(
    () => new Map(),
  );
  useEffect(() => {
    const made = new Map<ChannelId, ChatChannelClient>();
    for (const id of key ? key.split("\n") : []) made.set(id, chat.join(id));
    setClients(made);
    return () => {
      for (const client of made.values()) client.close();
    };
  }, [chat, key]);
  return clients;
}

/**
 * Live view of one channel client. The view is kept in state (set from the
 * subscription), so it never depends on getView() returning a cached object.
 */
export function useChannelView(client: ChatChannelClient | undefined): ChatChannelView {
  const [entry, setEntry] = useState<{ client: ChatChannelClient; view: ChatChannelView } | null>(
    null,
  );
  useEffect(() => {
    if (!client) return;
    setEntry({ client, view: client.getView() });
    return client.subscribe((view) => setEntry({ client, view }));
  }, [client]);
  if (!client) return EMPTY_CHAT_VIEW;
  if (entry && entry.client === client) return entry.view;
  return client.getView();
}

/**
 * Runs `load` whenever `deps` change and returns its result, or undefined while
 * the current deps have no answer yet (so a dependency change shows "loading"
 * without a synchronous setState in the effect). Answers for stale deps, or
 * arriving after unmount, are dropped. `load` must not reject.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): T | undefined {
  const [state, setState] = useState<{ deps: readonly unknown[]; value: T } | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((value) => {
      if (live) setState({ deps, value });
    });
    return () => {
      live = false;
    };
    // The caller owns the dependency list: it mirrors the request inputs.
  }, deps);
  if (!state || !sameDeps(state.deps, deps)) return undefined;
  return state.value;
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Follows `value` after `ms` without changes (no request is made per keystroke). */
export function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return out;
}
