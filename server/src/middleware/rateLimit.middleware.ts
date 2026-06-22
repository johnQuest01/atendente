import rateLimit from 'express-rate-limit';

/**
 * Limites de requisição (anti força-bruta / anti-flood). Os valores são
 * generosos para não atrapalhar o uso normal do painel, mas cortam abuso.
 * Em produção o app roda atrás de proxy (Render) — lembre de `trust proxy`.
 */

const json = {
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Tente novamente em instantes.' } },
};

/** Geral para a API autenticada. */
export const apiLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: 1000,
  ...json,
});

/** Estrito para login e desbloqueio do cadeado (alvo de força-bruta). */
export const authLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  // Não conta tentativas BEM-SUCEDIDAS: só pune erros (senha errada).
  skipSuccessfulRequests: true,
  ...json,
});

/** Webhook do WhatsApp: alto o suficiente para tráfego real, freia floods. */
export const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  ...json,
});
