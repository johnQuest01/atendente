import { complete } from './orchestrator';
import { isWebSearchToolAvailable, searchWebDetailed } from './tools/web-search';
import { extractLiveQuoteLine } from './live-quotes';
import { extractSearchQuery } from '../reminders/reminder-actions';
import { rememberOwnerLastSearch } from '../reminders/owner-last-search';

const SUMMARIZE_SYSTEM =
  'Você monta a resposta de uma pesquisa para WhatsApp, em português. ' +
  'Regras: (1) Responda o que a pessoa pediu em até 6 linhas, com o fato mais atual e confiável. ' +
  '(2) Prefira fontes de notícia, governo, bolsa, enciclopédia ou veículo conhecido — ignore sites ruins, tradutor, cupom, Pinterest. ' +
  '(3) Se houver COTAÇÃO AO VIVO no texto, esse número ganha de snippet velho. ' +
  '(4) Inclua 1 link HTTP real que veio nos resultados. Nunca invente URL, nunca use translate.google. ' +
  '(5) Não cole lista de snippets. Não repita transcrição de áudio, "paulo" nem "pesquise".';

export async function searchAndAnswer(input: {
  query: string;
  tenantId: string;
  connectionId?: string | null;
  ownerPhone?: string | null;
  wantLink?: boolean;
}): Promise<string> {
  const query = extractSearchQuery(input.query) || input.query.trim();
  if (!query) return 'Não entendi o que pesquisar. Manda de novo o assunto?';
  if (!isWebSearchToolAvailable()) {
    return 'Não consigo pesquisar agora: a busca na web está sem chave neste servidor.';
  }

  const hits = await searchWebDetailed(query);
  const liveFx = extractLiveQuoteLine(hits.text);
  if (!hits.text || /^Nenhum resultado/i.test(hits.text)) {
    return `Não achei fonte atual para: ${query}`;
  }

  if (input.ownerPhone) {
    rememberOwnerLastSearch(input.tenantId, input.ownerPhone, {
      query: hits.query || query,
      urls: hits.urls,
      answer: liveFx,
    });
  }

  const formatted = await complete(
    {
      system: SUMMARIZE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `Pedido: ${query}`,
            `Resultados:\n${hits.text}`,
            hits.urls[0] ? `Link preferido: ${hits.urls[0]}` : '',
            input.wantLink ? 'A pessoa pediu o link: inclua o URL.' : 'Inclua o URL da melhor fonte.',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      maxTokens: 500,
      temperature: 0.1,
    },
    input.tenantId,
    { meter: true, connectionId: input.connectionId },
  );
  let text = formatted?.text?.trim() || '';
  if (!text) {
    const link = hits.urls[0] ? `\n${hits.urls[0]}` : '';
    text = `${liveFx ? `${liveFx}\n` : ''}${hits.text}${link}`.slice(0, 1500);
  } else if (hits.urls[0] && !/https?:\/\//i.test(text)) {
    text = `${text}\n${hits.urls[0]}`;
  }
  return text.slice(0, 3500);
}

export function formatLastSearchLink(last: {
  query: string;
  urls: string[];
  answer: string;
}): string {
  const url = last.urls[0];
  if (!url) return 'Não tenho o link da busca anterior. Manda de novo o que quer pesquisar?';
  const head = last.answer ? `${last.answer}\n` : '';
  return `${head}Fonte: ${url}`.trim();
}
