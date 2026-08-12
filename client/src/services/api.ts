import axios, { type AxiosError } from 'axios';

const baseURL = `${import.meta.env.VITE_API_URL ?? ''}/api`;

export const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
});

const TOKEN_KEY = 'mayra.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

const BLOCK_TOKEN_KEY = 'mayra.blockToken';

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Área restrita de números bloqueados: envia o token do cadeado quando houver.
  const url = config.url ?? '';
  if (url.includes('/blocked') && !url.includes('/blocked/unlock')) {
    const blockToken = localStorage.getItem(BLOCK_TOKEN_KEY);
    if (blockToken) config.headers['x-block-token'] = blockToken;
  }
  // Cadeado de conversa: token de unlock por conversa (sessionStorage).
  const chatMatch = /\/conversations\/([0-9a-f-]{36})/i.exec(url);
  if (chatMatch?.[1] && !url.includes('/unlock') && !url.includes('/lock')) {
    const unlock = sessionStorage.getItem(`mayra.chatUnlock.${chatMatch[1]}`);
    if (unlock) config.headers['x-chat-unlock'] = unlock;
  }
  return config;
});

interface ApiErrorBody {
  error?: { message?: string; code?: string; details?: unknown };
}

const ACCESS_BLOCK_CODES = ['TRIAL_EXPIRED', 'TENANT_INACTIVE'];

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const body = error.response?.data as ApiErrorBody | undefined;
    const code = body?.error?.code;
    // 401 de senha do cadeado (legado) não deve derrubar o login do painel.
    const skipLogout = code === 'CHAT_LOCK_BAD_PASSWORD';
    if (error.response?.status === 401 && getToken() && !skipLogout) {
      setToken(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    // Teste vencido / conta desativada: o painel troca a tela por um aviso, em
    // vez de deixar cada requisição falhando isoladamente.
    if (code && ACCESS_BLOCK_CODES.includes(code)) {
      // Import tardio: o store importa daqui, então evitamos ciclo no módulo.
      void import('@/store/appStore').then((m) =>
        m.setAccessBlocked(body?.error?.message ?? 'Seu acesso está suspenso.'),
      );
    }
    return Promise.reject(error);
  },
);

/** Extrai uma mensagem de erro amigável de uma falha do Axios. */
export function getErrorMessage(error: unknown, fallback = 'Algo deu errado.'): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as ApiErrorBody | undefined;
    return body?.error?.message ?? error.message ?? fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}
