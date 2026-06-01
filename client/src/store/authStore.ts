import { create } from 'zustand';
import type { User } from '@/types';
import { getToken, setToken } from '@/services/api';

interface AuthState {
  user: User | null;
  token: string | null;
  isInitialized: boolean;
  setAuth: (user: User, token: string) => void;
  setUser: (user: User | null) => void;
  setInitialized: (value: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: getToken(),
  isInitialized: false,
  setAuth: (user, token) => {
    setToken(token);
    set({ user, token });
  },
  setUser: (user) => set({ user }),
  setInitialized: (value) => set({ isInitialized: value }),
  logout: () => {
    setToken(null);
    set({ user: null, token: null });
  },
}));
