/**
 * Módulo reservado para a fase Meta Cloud.
 * Na fase Z-API fica HARD-OFF — não expor como toggle casual de UI.
 *
 * Quando businessInitiatedEnabled for true (Cloud):
 * - reabrir fora da janela 24h → template aprovado
 * - marketing → opt-in registrado
 * - classificador de janela 24h
 */

import { AppError } from '../../utils/errors';
import type { ProviderCapabilities } from './types';

/** Hard-off na fase Z-API. Ligar só na migração Cloud. */
export const BUSINESS_INITIATED_ENABLED = false;

export const ZAPI_CAPABILITIES: ProviderCapabilities = {
  businessInitiated: false,
};

export const CLOUD_CAPABILITIES: ProviderCapabilities = {
  businessInitiated: true,
};

/**
 * Qualquer tentativa de envio business-initiated na fase atual.
 * Plugar no Cloud sem mexer no restante do pipeline.
 */
export function assertBusinessInitiatedAllowed(_opts?: {
  hasApprovedTemplate?: boolean;
  hasOptIn?: boolean;
  within24hWindow?: boolean;
}): void {
  if (!BUSINESS_INITIATED_ENABLED) {
    throw new AppError(
      'Envio business-initiated está desativado nesta fase (Z-API). Reservado para Cloud com template/opt-in.',
      403,
      'BUSINESS_INITIATED_DISABLED',
    );
  }
  // Fase Cloud: validar template / opt-in / janela — ainda não implementado.
  throw new AppError(
    'Business-initiated ainda não implementado nesta fase.',
    501,
    'BUSINESS_INITIATED_NOT_IMPLEMENTED',
  );
}
