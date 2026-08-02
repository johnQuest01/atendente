import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface AppState {
  toasts: Toast[];
  addToast: (message: string, variant?: ToastVariant) => void;
  removeToast: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  toasts: [],
  addToast: (message, variant = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((state) => ({ toasts: [...state.toasts, { id, message, variant }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 3500);
  },
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Atalho fora de componentes React. */
export function toast(message: string, variant: ToastVariant = 'info'): void {
  useAppStore.getState().addToast(message, variant);
}

/**
 * Acesso da EMPRESA ao produto. O backend responde 402/403 quando o período de
 * teste vence ou a conta é desativada; guardamos a mensagem para o painel
 * explicar o que houve em vez de exibir erro solto em cada tela.
 */
interface AccessBlockState {
  message: string | null;
  setBlocked: (message: string) => void;
  clear: () => void;
}

export const useAccessBlock = create<AccessBlockState>((set) => ({
  message: null,
  setBlocked: (message) => set({ message }),
  clear: () => set({ message: null }),
}));

export function setAccessBlocked(message: string): void {
  useAccessBlock.getState().setBlocked(message);
}

/**
 * Acesso à área restrita de "Números bloqueados". O token (escopo 'blocklist')
 * é emitido pelo backend após o login do cadeado e fica salvo no navegador.
 */
const BLOCK_TOKEN_KEY = 'mayra.blockToken';

interface BlockAccessState {
  token: string | null;
  setToken: (token: string) => void;
  clear: () => void;
}

export const useBlockAccess = create<BlockAccessState>((set) => ({
  token: localStorage.getItem(BLOCK_TOKEN_KEY),
  setToken: (token) => {
    localStorage.setItem(BLOCK_TOKEN_KEY, token);
    set({ token });
  },
  clear: () => {
    localStorage.removeItem(BLOCK_TOKEN_KEY);
    set({ token: null });
  },
}));

export function getBlockToken(): string | null {
  return useBlockAccess.getState().token;
}

export function clearBlockToken(): void {
  useBlockAccess.getState().clear();
}
