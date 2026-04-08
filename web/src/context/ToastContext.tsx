import { createContext, useContext, useState, useCallback, useRef, ReactNode } from "react";

export type ToastLevel = "error" | "warn" | "ok" | "info";

export interface Toast {
  id: number;
  message: string;
  level: ToastLevel;
  /** ms before auto-dismiss. default 7000 */
  duration?: number;
  /** true while the slide-out animation is playing */
  leaving?: boolean;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (message: string, level?: ToastLevel, duration?: number) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let _nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    // Mark as leaving → triggers slide-out CSS
    setToasts((prev) => prev.map((t) => t.id === id ? { ...t, leaving: true } : t));
    // Remove after animation completes (400ms)
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 420);
  }, []);

  const push = useCallback((message: string, level: ToastLevel = "error", duration = 7000) => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, message, level }]);
    const t = setTimeout(() => dismiss(id), duration);
    timers.current.set(id, t);
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toasts, push, dismiss }}>
      {children}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
