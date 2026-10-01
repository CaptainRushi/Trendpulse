import type React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface Toast {
  id: number;
  tone: "info" | "good" | "bad";
  message: string;
}

const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => undefined);

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((toast: Omit<Toast, "id">) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast" data-tone={toast.tone}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: Omit<Toast, "id">) => void {
  return useContext(ToastContext);
}
