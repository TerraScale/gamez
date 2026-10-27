/** React bindings for the slot registry: a provider, a `useSlot` hook and `<Slot>`. */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { SlotEntry, SlotRegistry } from "./registry.ts";

const SlotContext = createContext<SlotRegistry | null>(null);

export function SlotProvider({
  registry,
  children,
}: {
  registry: SlotRegistry;
  children?: ReactNode;
}) {
  return <SlotContext.Provider value={registry}>{children}</SlotContext.Provider>;
}

/** Live entries of `name`; re-renders only when that slot changes. */
export function useSlot(name: string): readonly SlotEntry[] {
  const registry = useContext(SlotContext);
  if (!registry) throw new Error("useSlot/<Slot> must be used inside <SlotProvider>");
  return useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.list(name),
    () => registry.list(name),
  );
}

/** Renders every component registered in `name`, passing `props` to each. */
export function Slot<P extends object>({ name, props }: { name: string; props?: P }) {
  const entries = useSlot(name);
  return (
    <>
      {entries.map((entry) => {
        const Component = entry.component;
        return <Component key={entry.id} {...props} />;
      })}
    </>
  );
}
