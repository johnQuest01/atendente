import { useEffect } from 'react';
import { api, getErrorMessage, getToken, setToken } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { toast } from '@/store/appStore';
import type { User } from '@/types';

interface LoginResponse {
  token: string;
  user: User;
}

export function useAuth() {
  const { user, token, isInitialized, setAuth, setUser, setInitialized, logout } = useAuthStore();

  async function login(email: string, password: string): Promise<boolean> {
    try {
      const { data } = await api.post<LoginResponse>('/auth/login', { email, password });
      setAuth(data.user, data.token);
      return true;
    } catch (err) {
      toast(getErrorMessage(err, 'Não foi possível entrar.'), 'error');
      return false;
    }
  }

  return {
    user,
    token,
    isInitialized,
    isAuthenticated: Boolean(token),
    login,
    logout,
    setUser,
    setInitialized,
  };
}

/** Carrega o usuário atual a partir do token salvo (executa uma vez). */
export function useBootstrapAuth(): void {
  const { setUser, setInitialized, logout } = useAuthStore();

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      if (!getToken()) {
        setInitialized(true);
        return;
      }
      try {
        const { data } = await api.get<{ user: User }>('/auth/me');
        if (active) setUser(data.user);
      } catch {
        setToken(null);
        logout();
      } finally {
        if (active) setInitialized(true);
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [setUser, setInitialized, logout]);
}
