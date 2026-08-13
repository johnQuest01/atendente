/**
 * Caderno de treino da secretária: o dono escreve no app, a IA interpreta e executa.
 * Sem isso o comportamento padrão (persona + tools) segue valendo.
 */
export function formatSecretaryPlaybook(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  return [
    'TREINO DO DONO (ordens permanentes DESTE WhatsApp — PRIORIDADE MÁXIMA):',
    'Interprete o sentido e EXECUTE. Se discordar da persona, do tom ou do fluxo padrão, o TREINO GANHA.',
    'Use as tools (enviar, ler conversa, avisar, pesquisar, parar/voltar a responder, orientar atendimento) quando o treino pedir uma ação — não só “combinado”.',
    'Se o treino falar de quem te chamar / qualquer pessoa / quem mandar mensagem, vale para CONTATOS neste número. O dono (números autorizados) continua mandando comando; o treino NÃO cala o dono.',
    'Pode ir acumulando regras: cada linha nova soma, a mais específica ganha em conflito.',
    '',
    text,
  ].join('\n');
}
