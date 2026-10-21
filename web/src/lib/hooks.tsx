import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { request, requestAll, errorMessage } from "./api";
import type { Session, User } from "./types";
export const AppContext = createContext<{
  session: Session;
  notify: (text: string, error?: boolean) => void;
  updateUser: (user: User) => void;
}>({ session: {} as Session, notify: () => {}, updateUser: () => {} });
export const useApp = () => useContext(AppContext);
export function useResource<T>(path: string | null, revision = 0, poll = 0, allPages = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!path);
  const [reload, setReload] = useState(0);
  const currentPath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const changed = currentPath.current !== path;
    currentPath.current = path;
    if (changed) setData(null);
    setError("");
    if (changed) setLoading(!!path);
    if (!path) return;
    const controller = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await (allPages
          ? (requestAll(path, controller.signal) as Promise<T>)
          : request<T>(path, { signal: controller.signal }));
        if (!controller.signal.aborted) {
          setData(result);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      } finally {
        busy = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = poll ? setInterval(load, poll) : undefined;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [path, revision, reload, poll, allPages]);
  return { data, setData, error, loading, refresh: () => setReload((n) => n + 1) };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { notify } = useApp();
  async function run(work: () => Promise<unknown>, success?: string) {
    if (busy) return false;
    setBusy(true);
    setError("");
    try {
      await work();
      if (success) notify(success);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setError(message);
      notify(message, true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run, error };
}
export function SessionProvider({
  session,
  notify,
  updateUser,
  children,
}: {
  session: Session;
  notify: (text: string, error?: boolean) => void;
  updateUser: (user: User) => void;
  children: ReactNode;
}) {
  return (
    <AppContext.Provider value={{ session, notify, updateUser }}>{children}</AppContext.Provider>
  );
}
