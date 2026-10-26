import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from "react";
import { request, requestAll, errorMessage } from "./api";
import type { Session, User } from "./types";
export const AppContext = createContext<{
  session: Session;
  notify: (text: string, error?: boolean) => void;
  updateUser: (user: User) => void;
}>({ session: {} as Session, notify: () => {}, updateUser: () => {} });
export const useApp = () => useContext(AppContext);
// Polls never overlap a request and stop while the document is hidden.
export function useForegroundRefresh(refresh: () => void, interval: number) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!interval) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!document.hidden) timer = setInterval(() => latest.current(), interval);
    };
    const visible = () => {
      start();
      if (!document.hidden) latest.current();
    };
    start();
    document.addEventListener("visibilitychange", visible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [interval]);
}
export function useDebouncedValue<T>(value: T, delay = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
export function useResource<T>(path: string | null, revision = 0, poll = 0, allPages = false) {
  const [snapshot, setSnapshot] = useState<{ path: string | null; data: T | null }>({
    path,
    data: null,
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(!!path);
  const [reload, setReload] = useState(0);
  const running = useRef(false);
  const data = snapshot.path === path ? snapshot.data : null;
  const refresh = () => setReload((n) => n + 1);
  useForegroundRefresh(
    () => {
      if (!running.current) refresh();
    },
    path ? poll : 0,
  );
  useEffect(() => {
    setError("");
    setSnapshot((old) => (old.path === path ? old : { path, data: null }));
    setPending(!!path);
    if (!path) return;
    const controller = new AbortController();
    running.current = true;
    void (
      allPages
        ? (requestAll(path, controller.signal) as Promise<T>)
        : request<T>(path, { signal: controller.signal })
    )
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot({ path, data: result });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          running.current = false;
          setPending(false);
        }
      });
    return () => {
      controller.abort();
      running.current = false;
    };
  }, [path, revision, reload, allPages]);
  const setData = (update: T | null | ((old: T | null) => T | null)) =>
    setSnapshot((old) => ({
      path,
      data:
        typeof update === "function"
          ? (update as (old: T | null) => T | null)(old.path === path ? old.data : null)
          : update,
    }));
  return {
    data,
    setData,
    error,
    loading: !!path && !data && (pending || snapshot.path !== path),
    refreshing: pending,
    refresh,
  };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [pendingKey, setPendingKey] = useState<string>();
  const running = useRef(false);
  const [error, setError] = useState("");
  const { notify } = useApp();
  async function run(work: () => Promise<unknown>, success?: string, key?: string) {
    if (running.current) return false;
    running.current = true;
    setPendingKey(key);
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
      running.current = false;
      setPendingKey(undefined);
      setBusy(false);
    }
  }
  return { busy, pendingKey, run, error };
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
