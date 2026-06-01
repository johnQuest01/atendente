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
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401 && getToken()) {
      setToken(null);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

interface ApiErrorBody {
  error?: { message?: string; code?: string; details?: unknown };
}

/** Extrai uma mensagem de erro amigável de uma falha do Axios. */
export function getErrorMessage(error: unknown, fallback = 'Algo deu errado.'): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as ApiErrorBody | undefined;
    return body?.error?.message ?? error.message ?? fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}
