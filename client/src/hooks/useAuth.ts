import { useEffect } from 'react';
import { api, getErrorMessage, getToken, setToken } from '@/services/api';
import { useAuthStore } from '@/store/authStore';
import { toast, useAccessBlock } from '@/store/appStore';
import { reauthSocket } from '@/hooks/useSocket';
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
      // Sessão nova: um bloqueio antigo (teste vencido) não pode grudar na tela.
      useAccessBlock.getState().clear();
      reauthSocket();
      return true;
    } catch (err) {
      toast(getErrorMessage(err, 'Não foi possível entrar.'), 'error');
      return false;
    }
  }

  function logoutAndDisconnect(): void {
    logout();
    useAccessBlock.getState().clear();
    reauthSocket();
  }

  return {
    user,
    token,
    isInitialized,
    isAuthenticated: Boolean(token),
    login,
    logout: logoutAndDisconnect,
    setUser,
    setInitialized,
  };
}

/** Carrega o usuário atual a partir do token salvo (executa uma vez). */
export function useBootstrapAuth(): void {
  const { setUser, setInitialized, logout } = useAuthStore();

  useEffect(() => {
    let active = true;
    // Se /auth/me travar (API lenta, rede, SW antigo), libera a tela de login
    // em vez de ficar eternamente em "Carregando...".
    const failSafe = window.setTimeout(() => {
      if (active) setInitialized(true);
    }, 8_000);

    async function bootstrap() {
      if (!getToken()) {
        setInitialized(true);
        return;
      }
      try {
        const { data } = await api.get<{ user: User }>('/auth/me', {
          timeout: 7_000,
        });
        if (active) setUser(data.user);
      } catch {
        setToken(null);
        logout();
      } finally {
        if (active) setInitialized(true);
        window.clearTimeout(failSafe);
      }
    }
    void bootstrap();
    return () => {
      active = false;
      window.clearTimeout(failSafe);
    };
  }, [setUser, setInitialized, logout]);
}
