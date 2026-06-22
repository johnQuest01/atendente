com foco em segurança trabalhando neste projeto — um atendente de WhatsApp B2B multi-empresa (SaaS): React PWA (client/) + Node/Express/TypeScript (server/) + PostgreSQL no Neon + Z-API/Evolution + provedores de IA com failover. O backend roda no Render e o frontend na Vercel.

O projeto já evoluiu bastante e está saudável: os deploys estão verdes, o backend compila sem erros, o isolamento por tenant_id está aplicado na camada de aplicação (derivado do JWT, usado no WHERE das queries), as credenciais são cifradas com AES-256-GCM e há failover de IA. Esta tarefa é só corrigir os bugs e lacunas pontuais abaixo — não adicionar features novas de produto. Faça mudanças mínimas, focadas e sem regressões.

PRIMEIRO PASSO — OBRIGATÓRIO

Antes de mudar qualquer coisa, leia os arquivos do projeto e confirme por escrito o diagnóstico de cada item abaixo, citando os arquivos/trechos. Explore por conta própria a camada de banco (queries, migrations), o middleware de autenticação, o controller de mídia, o orquestrador de IA e o tsconfig do frontend. Só depois aplique as correções, validando o typecheck ao final de cada bloco.


BUG 1 (CRÍTICO) — Sem Row-Level Security (RLS) no banco

Problema: o isolamento entre empresas é 100% na camada de aplicação. Hoje todas as queries filtram por tenant_id, mas não há rede de proteção no banco: se UMA query futura esquecer o filtro, vaza dados entre tenants. Confirme que não há ENABLE ROW LEVEL SECURITY/policies nas migrations atuais.

Correção desejada (defesa em profundidade):


Criar uma nova migration que habilite RLS em TODAS as tabelas com tenant_id (clients, conversations, messages_log, audios, text_scripts, products, keywords, media_files, blocked_numbers, settings, users, whatsapp_connections, ai_providers — confirme a lista real no schema).
Criar uma policy por tabela que permita acesso apenas às linhas onde tenant_id é igual ao tenant da sessão, lido de uma variável de sessão do Postgres (ex.: current_setting('app.tenant_id', true)). Aplicar a policy para SELECT/INSERT/UPDATE/DELETE.
No acesso ao banco da aplicação, definir essa variável de sessão por transação/checkout de conexão, a partir do tenant_id do usuário autenticado (ou do tenant resolvido no webhook). Garantir que toda query passe a rodar com o tenant correto setado.
Cuidado com o pool de conexões: como o pg reusa conexões, a variável de sessão precisa ser setada no início de cada operação e não vazar para a próxima. Avalie usar SET LOCAL app.tenant_id dentro de uma transação por requisição, ou um wrapper de conexão que faz o SET antes de cada query e limpa depois.
Definir uma identidade/admin de manutenção (ou BYPASSRLS apenas para migrations/seed) para que migrations e o seed continuem funcionando.
A migration deve ser idempotente e segura para rodar sobre os dados existentes (todos já têm tenant_id).


Importante: o RLS é complemento, não substituto — mantenha os filtros tenant_id que já existem nas queries. O objetivo é que, mesmo com um bug de aplicação, o banco recuse o vazamento.

BUG 2 (ALTO) — Mídia acessível sem escopo de tenant

Problema: o endpoint público de mídia e a função que busca o áudio/arquivo binário pegam por id sem filtrar tenant_id (confirme em media.controller.ts e nas queries de audios/media_files, ex.: getAudioBinary(id) e a rota /media/...). Com o R2 agora como caminho principal, esse é o caminho legado/dev, mas em multi-tenant um id conhecido permitiria acesso cruzado.

Correção desejada (escolha a abordagem mais coerente com o código atual, e justifique):


Preferencial: servir mídia sensível por URL assinada do R2 com expiração curta, em vez de um endpoint público por id; ou
Alternativa: manter o endpoint /media, mas exigir que ele resolva e valide o tenant_id (por exemplo, mídia acessível apenas via uma URL que carregue um token assinado contendo o tenant, com expiração), de modo que um id de outra empresa não possa ser buscado.
Em qualquer caso, as funções de busca de binário no banco devem passar a receber e filtrar por tenant_id quando a chamada vier de um contexto autenticado.


Garanta que o WhatsApp/Z-API continue conseguindo baixar a mídia (o fluxo de envio não pode quebrar).

BUG 3 (MÉDIO) — Cooldown do failover de IA só em memória

Problema: o controle de cooldown dos provedores de IA é um Map em memória (confirme em services/ai/orchestrator.ts). Funciona com uma instância, mas não é compartilhado se o backend escalar para múltiplas instâncias; eles persistem cooldownUntil no banco, o que ameniza.

Correção desejada (leve): ao resolver a cadeia de provedores, considerar também o cooldownUntil persistido no banco (não apenas o Map em memória), de modo que o estado de cooldown seja consistente entre instâncias e após reinício. Manter o cache em memória como otimização, mas a verdade vem do banco. Não reescrever o orquestrador — apenas tornar a leitura do cooldown consciente do valor persistido.

BUG 4 (BAIXO) — Aviso de tsconfig no frontend

Problema: o typecheck do client/ emite TS5101: Option 'baseUrl' is deprecated (TypeScript 7.0). Não quebra o build atual, mas polui e vai falhar em versões futuras.

Correção desejada: ajustar o client/tsconfig.json para silenciar/resolver de forma definitiva — por exemplo, adicionando "ignoreDeprecations": "6.0" agora e, de preferência, migrando os paths para não depender de baseUrl (usar paths com ${configDir} ou caminhos relativos conforme suportado). Garantir que os imports com alias (@/...) continuem funcionando no Vite e no typecheck.

(Opcional, se for rápido) Endurecimento pontual já recomendado antes

Se não exigir refatoração grande, avalie aplicar:


Revogação de sessão na troca de senha (ex.: um token_version por usuário incluído no JWT e validado no middleware), para que trocar a senha invalide tokens antigos.
Confirmar que nenhum segredo aparece em logs e que o erro 500 nunca vaza detalhe interno (já deve estar, valide).



Critérios de aceite (validar ao final)


npx tsc -p server --noEmit e npx tsc -p client --noEmit passam sem erros nem avisos (incluindo o do baseUrl).
RLS ativo: com a variável de sessão de tenant setada, uma query sem o filtro de aplicação ainda assim só enxerga as linhas do tenant corrente; um teste manual (setar tenant A e tentar ler id de tenant B) retorna vazio. Migrations e seed continuam rodando.
Mídia isolada: não é possível baixar a mídia de um tenant usando um id/credencial de outro tenant; o envio de áudio/imagem pelo WhatsApp continua funcionando.
Cooldown consistente: o estado de cooldown de IA sobrevive a reinício do processo (vem do banco), e o failover continua funcionando.
Nenhuma regressão: recebimento e transcrição de áudio do cliente, memória por conversa, painel, dashboard (com métricas por tenant) e o fluxo multi-empresa seguem funcionando.


Regras


Respeite as convenções do projeto: backend em .ts (sem JSX), componentes React em .tsx. Não renomeie arquivos nem invente caminhos — edite os arquivos reais.
TypeScript estrito, sem any; sem imports não usados.
Migrations idempotentes e seguras sobre os dados existentes; mostre o SQL da migration de RLS e explique a estratégia de SET da variável de sessão antes de aplicar, pois mexe no acesso ao banco inteiro.
Não remova os filtros tenant_id já existentes nas queries (RLS é complemento).
Mudanças mínimas e focadas; rode o typecheck ao final de cada bug corrigido.
Ao concluir, escreva um resumo do que mudou, quais arquivos/migrations foram criados, e o passo a passo para aplicar em produção (rodar a migration no Neon, variáveis necessárias, como testar o isolamento ponta a ponta).


Comece pelo PRIMEIRO PASSO: leia o projeto e confirme por escrito o diagnóstico dos 4 bugs. Em seguida, corrija na ordem BUG 1 → BUG 4, validando o typecheck a cada etapa. O BUG 1 (RLS) é o mais importante — capriche e apresente a migration antes de aplicar.