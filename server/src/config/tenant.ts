/**
 * Tenant padrao da Fase 1 do multi-tenancy.
 *
 * Toda a operacao atual (a empresa principal) pertence a este tenant. O UUID e
 * fixo e identico ao inserido na migration 014 (`tenants`). Usado:
 *  - no seed (vincula o admin a esta empresa);
 *  - no webhook (Fase 1 ha um unico WhatsApp global -> todo inbound e deste tenant);
 *  - como fallback no middleware para tokens antigos (emitidos antes do tenant_id).
 *
 * Fase 2: o webhook resolvera o tenant por instancia/token de cada empresa e
 * esta constante deixa de ser usada no caminho de entrada.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';
