-- 013: Integridade do isolamento de conversas.
-- Garante que cada cliente tenha NO MÁXIMO uma conversa ATIVA (status <> 'closed').
-- Isso elimina a fragmentação por corrida: duas mensagens quase simultâneas de um
-- mesmo cliente sem conversa aberta poderiam criar duas conversas "open" e dividir
-- o histórico que a IA lê. (Nunca foi mistura entre clientes — apenas divisão do
-- histórico do MESMO cliente; aqui fechamos essa brecha de vez.)

-- 1) Normaliza dados existentes: se algum cliente já tiver mais de uma conversa
--    ativa, mantém a mais recente e fecha as demais (não apaga nada).
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY client_id
           ORDER BY started_at DESC, id DESC
         ) AS rn
    FROM conversations
   WHERE status <> 'closed'
)
UPDATE conversations c
   SET status = 'closed',
       closed_at = COALESCE(c.closed_at, NOW())
  FROM ranked r
 WHERE c.id = r.id
   AND r.rn > 1;

-- 2) Impõe a regra no banco: índice único parcial sobre client_id para linhas
--    não-fechadas. Uma 2ª tentativa concorrente de abrir conversa falha por
--    violação de unicidade — e o código (findOrCreateOpenConversation) trata
--    isso buscando a conversa que venceu a corrida.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_active_per_client
  ON conversations (client_id)
  WHERE status <> 'closed';
