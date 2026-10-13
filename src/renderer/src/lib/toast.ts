// Tiny toast store. Toasts are transient and never persisted.
import { create } from 'zustand'

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text?: string;
}

interface ToastState {
  items: Toast[];
  push(kind: ToastKind, title: string, text?: string): number;
  dismiss(id: number): void;
}

let nextId = 1

export const useToasts = create<ToastState>()((set, get) => ({
  items: [],
  push(kind, title, text) {
    const id = nextId++
    // Keep the stack short so a burst of errors does not bury the city.
    const items = [...get().items, { id, kind, title, text }].slice(-4)
    set({ items })
    const ttl = kind === 'error' ? 7000 : 4200
    setTimeout(() => get().dismiss(id), ttl)
    return id
  },
  dismiss(id) {
    set({ items: get().items.filter((t) => t.id !== id) })
  }
}))

/** Shortcut for code outside React. */
export const toast = {
  info: (title: string, text?: string) => useToasts.getState().push('info', title, text),
  success: (title: string, text?: string) => useToasts.getState().push('success', title, text),
  error: (title: string, text?: string) => useToasts.getState().push('error', title, text)
}

/** Message text from an unknown thrown value. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  // Electron prefixes IPC failures with "Error invoking remote method 'channel': Error: ".
  const clean = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
  return clean || 'Something went wrong.'
}
