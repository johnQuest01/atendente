import { AppError } from '../utils/errors';

/**
 * Registro TIPADO de comportamentos ajustáveis no painel (dirige a UI).
 *
 * A tabela `settings` já é key-value por tenant. Este registro é o que permite
 * "atribuir mais sem vir codificar": para expor um novo ajuste editável, basta
 * adicionar UMA entrada aqui — o card genérico no painel renderiza o campo certo
 * (texto, número ou switch) e a API valida contra o tipo/min/max daqui.
 *
 * Os cards dedicados (persona de vendas e de lembretes, com playground) seguem
 * separados; este registro cobre os ajustes simples.
 */

export type BehaviorSettingType = 'text' | 'longtext' | 'number' | 'toggle';
export type BehaviorScope = 'sales' | 'reminder' | 'geral';

export interface BehaviorSetting {
  key: string;
  label: string;
  description: string;
  type: BehaviorSettingType;
  /** Valor padrão SEMPRE como string (é como fica no banco). */
  default: string;
  min?: number;
  max?: number;
  scope: BehaviorScope;
}

export const BEHAVIOR_SETTINGS: BehaviorSetting[] = [
  {
    key: 'ai_attendant_name',
    label: 'Nome do atendente',
    description:
      'Preenche {NOME_DO_ATENDENTE} na personalidade (ex.: Ana, Mayra). Deixe vazio para "Mayra".',
    type: 'text',
    default: 'Mayra',
    scope: 'sales',
  },
  {
    key: 'ai_business_blurb',
    label: 'O que o negócio faz ou vende',
    description:
      'Preenche {O_QUE_O_NEGOCIO_FAZ_OU_VENDE} (ex.: "atacado de cosméticos para lojistas").',
    type: 'longtext',
    default: '',
    scope: 'sales',
  },
  {
    key: 'ai_temperature',
    label: 'Criatividade da IA (vendas)',
    description: '0 = objetivo e previsível; 1.5 = mais criativo e solto.',
    type: 'number',
    default: '0.7',
    min: 0,
    max: 1.5,
    scope: 'sales',
  },
  {
    key: 'ai_max_tokens',
    label: 'Tamanho máximo da resposta',
    description: 'Teto de tokens por resposta da IA de vendas (50–1200).',
    type: 'number',
    default: '500',
    min: 50,
    max: 1200,
    scope: 'sales',
  },
  {
    key: 'reminder_assistant_tone',
    label: 'Tom do assistente de lembretes',
    description: 'Uma linha de estilo, ex.: "direto e formal" ou "leve e amigável".',
    type: 'text',
    default: '',
    scope: 'reminder',
  },
];

export function findBehaviorSetting(key: string): BehaviorSetting | undefined {
  return BEHAVIOR_SETTINGS.find((s) => s.key === key);
}

/**
 * Valida um valor recebido contra o tipo/min/max do registro e devolve a STRING
 * a gravar. Lança AppError 400 quando inválido (mensagem amigável).
 */
export function coerceBehaviorValue(setting: BehaviorSetting, raw: unknown): string {
  if (setting.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new AppError(`${setting.label}: informe um número.`, 400, 'BAD_VALUE');
    if (setting.min != null && n < setting.min)
      throw new AppError(`${setting.label}: mínimo ${setting.min}.`, 400, 'BAD_VALUE');
    if (setting.max != null && n > setting.max)
      throw new AppError(`${setting.label}: máximo ${setting.max}.`, 400, 'BAD_VALUE');
    return String(n);
  }
  if (setting.type === 'toggle') {
    const truthy = raw === true || raw === 'true' || raw === 1 || raw === '1';
    const falsy = raw === false || raw === 'false' || raw === 0 || raw === '0';
    if (!truthy && !falsy) throw new AppError(`${setting.label}: use ligado/desligado.`, 400, 'BAD_VALUE');
    return truthy ? 'true' : 'false';
  }
  // text / longtext
  const s = String(raw ?? '');
  const max = setting.type === 'longtext' ? 12000 : 400;
  if (s.length > max) throw new AppError(`${setting.label}: texto muito longo (máx. ${max}).`, 400, 'BAD_VALUE');
  return s;
}
