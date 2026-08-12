/**
 * Smoke debug: persona placeholders + tool registry (sem chamar APIs externas).
 * Rode: npx tsx scripts/debug-persona-tools.ts
 */
import { applyPersonaPlaceholders, DEFAULT_AI_PERSONA } from '../src/config/persona';
import { buildDefaultToolRegistry, isWebSearchToolAvailable } from '../src/services/ai/tools';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function main(): void {
  console.log('=== debug persona + tools ===');

  // 1) Persona padrão tem seções do persona.MD
  for (const needle of [
    '## Quem você é',
    '## Como você fala',
    '## Como você vende',
    '## Regras que você nunca quebra',
    '## Como você conduz a conversa',
    '## Evite sempre',
    '{NOME_DO_ATENDENTE}',
    '{NOME_DO_NEGOCIO}',
    '{O_QUE_O_NEGOCIO_FAZ_OU_VENDE}',
  ]) {
    assert(DEFAULT_AI_PERSONA.includes(needle), `DEFAULT falta: ${needle}`);
  }
  console.log('OK persona.MD sections + placeholders no DEFAULT');

  // 2) Substituição
  const filled = applyPersonaPlaceholders(DEFAULT_AI_PERSONA, {
    attendantName: 'Ana',
    businessName: 'Loja Sol',
    businessBlurb: 'atacado de cosméticos para lojistas',
  });
  assert(filled.includes('**Ana**'), 'attendant não substituído');
  assert(filled.includes('**Loja Sol**'), 'negócio não substituído');
  assert(filled.includes('atacado de cosméticos'), 'blurb não substituído');
  assert(!filled.includes('{NOME_DO_ATENDENTE}'), 'placeholder attendant restante');
  assert(!filled.includes('{NOME_DO_NEGOCIO}'), 'placeholder negócio restante');
  assert(!filled.includes('{O_QUE_O_NEGOCIO_FAZ_OU_VENDE}'), 'placeholder blurb restante');
  assert(!filled.includes('[NOME DA LOJA]'), 'legado NOME DA LOJA restante');
  console.log('OK applyPersonaPlaceholders');

  // 3) Legado [NOME DA LOJA]
  const legacy = applyPersonaPlaceholders('Olá da [NOME DA LOJA]', { businessName: 'Mayra' });
  assert(legacy === 'Olá da Mayra', `legado falhou: ${legacy}`);
  console.log('OK legado [NOME DA LOJA]');

  // 4) Tools registry
  const reg = buildDefaultToolRegistry();
  const available = isWebSearchToolAvailable();
  console.log(`web_search available=${available} keys=${Object.keys(reg).join(',') || '(none)'}`);
  if (available) {
    assert(reg.web_search?.tool.name === 'web_search', 'web_search não registrada');
    assert(typeof reg.web_search?.execute === 'function', 'executor ausente');
  } else {
    assert(!reg.web_search, 'sem chave não deveria registrar web_search');
  }
  console.log('OK tool registry');

  console.log('=== ALL PASSED ===');
}

main();
