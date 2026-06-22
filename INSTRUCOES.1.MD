Você é um engenheiro full-stack sênior trabalhando neste projeto — um atendente de WhatsApp B2B (Mayra AI Sales): frontend React PWA + backend Node/Express/TypeScript + PostgreSQL no Neon + integração com WhatsApp (Z-API/Evolution) + Claude API. O backend roda no Render e o frontend na Vercel.

Problema relatado pelo usuário (reproduzir e diagnosticar)


"Ao salvar um áudio, ele funciona imediatamente. Mas ao salvar outros e testar em outros dias, numa situação real, ele NÃO envia o áudio — só manda mensagens de texto, sem o áudio. É como se os áudios não estivessem mais lá. E ao salvar áudios novos, dá erro dizendo que não foi possível salvar o áudio."



Há também um problema na tela de status do sistema: ela mostra tudo "OK" mesmo quando os serviços externos (WhatsApp, IA, transcrição) estão desconectados — ou seja, o status não reflete a realidade.

PRIMEIRO PASSO — OBRIGATÓRIO

Antes de mudar qualquer coisa, leia os arquivos do projeto e confirme por escrito a cadeia de causa raiz. Explore a estrutura por conta própria (backend e frontend), entenda como o áudio é gravado, convertido, armazenado e enviado ao WhatsApp, como a mídia é servida, como o status do sistema é calculado, e como o deploy está configurado. Em seguida, escreva 1–2 parágrafos explicando a causa raiz de CADA sintoma acima, citando os arquivos e trechos que comprovam o diagnóstico. Só depois disso parta para as correções.

Hipótese a validar (confirme ou refute com base no código real):


O áudio pode estar sendo enviado ao WhatsApp como conteúdo embutido (base64) e/ou servido por uma URL do próprio backend — o que falha quando o serviço hiberna, reinicia ou o disco é resetado, fazendo o áudio "sumir" e sobrar só o texto.
A conversão/gravação do áudio pode estar escrevendo no disco persistente do Render; quando esse disco enche, fica indisponível ou é recriado num deploy, o upload falha com "não foi possível salvar o áudio".
O endpoint de health pode estar apenas verificando se variáveis de ambiente existem, em vez de TESTAR de fato cada conexão.


O que precisamos que você resolva (objetivos, não receitas)

Implemente as mudanças necessárias para atingir estes resultados. Descubra você mesmo os arquivos certos e respeite a arquitetura e as convenções já existentes no projeto.


Armazenamento de mídia durável e com URL pública estável. Migrar o armazenamento de áudios (e, se fizer sentido, imagens) para um storage externo compatível com S3 — Cloudflare R2 — de modo que cada arquivo receba uma URL pública permanente (CDN) que o WhatsApp/Z-API sempre consiga baixar. A disponibilidade da mídia não pode depender de o backend estar no ar no momento do envio. Mantenha um fallback elegante para desenvolvimento local quando o R2 não estiver configurado.
Envio de áudio pela URL estável, sem base64. Ao enviar para o WhatsApp, usar a URL pública do storage diretamente, abandonando o envio por base64 (que estoura limite/timeout). O áudio deve chegar ao cliente como mensagem de voz.
Gravação/conversão de áudio que não dependa do disco persistente. A conversão (ffmpeg) e o arquivo temporário do upload devem usar o diretório temporário do sistema operacional (sempre gravável), eliminando o erro "não foi possível salvar o áudio" quando o disco do Render estiver cheio/indisponível. Não guardar o áudio como blob pesado no banco em produção (guardar apenas a URL).
Status do sistema REAL. O endpoint de health deve TESTAR de verdade cada serviço, com timeout curto e sem derrubar a resposta:

Banco (Neon): uma consulta simples.
Claude (Anthropic): uma chamada leve que valide a chave.
WhatsApp: consultar o estado real da conexão do provedor ativo (ex.: na Z-API, o endpoint de status indica se o celular está pareado; na Evolution, o estado da instância).
Transcrição (STT): validar a chave/endpoint configurado.
Cada serviço deve retornar um resultado com ok e um detail (motivo/erro legível).



Tela de status mostrando o motivo real. A tela de configurações/status deve consumir o novo formato e exibir, para cada serviço, o estado real e a causa quando falhar (ex.: "celular desconectado", "chave inválida", "timeout", "não configurado"). Desconectar o WhatsApp no provedor deve refletir na hora como falha; reconectar deve voltar a OK.
Variáveis de ambiente. Acrescentar ao schema de configuração e ao .env.example as variáveis necessárias para o R2 (account id, access key, secret, bucket e a URL pública do bucket) e, se ainda não houver, as de transcrição (provider, chave, base URL, modelo, idioma). O sistema deve detectar automaticamente se o R2 está configurado.


Critérios de aceite (validar ao final)


O typecheck do projeto passa SEM erros tanto no backend quanto no frontend.
Com o R2 configurado, ao subir o backend há um log indicando que o storage remoto está ativo; sem o R2, cai no modo local sem quebrar nada.
Salvar um áudio novo no painel funciona de forma confiável, mesmo que o disco persistente esteja cheio/indisponível (porque a conversão usa o diretório temporário do SO e o arquivo final vai para o R2). Não retorna mais "não foi possível salvar o áudio".
O áudio salvo é enviado ao cliente como mensagem de voz, disparando por palavra-chave, e continua funcionando dias depois e após redeploys (a URL é permanente e independente do backend).
Na tela de status, cada serviço mostra o estado REAL com o motivo da falha quando houver. Desconectar/reconectar o WhatsApp no provedor reflete corretamente.
Nenhuma regressão no restante do fluxo (recebimento e transcrição de áudio do cliente, memória por conversa, imagens de produto).


Regras


Respeite as extensões e convenções já usadas no projeto: arquivos de backend em .ts (sem JSX) e componentes React do frontend em .tsx. Não renomeie arquivos nem invente caminhos — navegue e edite os arquivos reais.
TypeScript estrito, sem any. Não deixe imports não usados.
Não invente nomes de funções, colunas ou tipos — confirme nos arquivos reais (camada de banco, tipos, serviços).
Mudanças mínimas e focadas; não refatore o que não faz parte do problema.
Comente em português apenas onde agregar clareza.
Ao final, escreva um resumo do que mudou e a lista de passos manuais necessários (criar o bucket no R2, preencher as variáveis no Render/ambiente, reconectar a Z-API se preciso) e como testar ponta a ponta.


Comece agora pelo PRIMEIRO PASSO: leia o projeto e confirme por escrito a cadeia de causa raiz. Só depois aplique as correções, rodando o typecheck ao final.