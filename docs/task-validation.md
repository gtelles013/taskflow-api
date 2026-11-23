# Validacao de entrada de tarefas

O modulo src/task-validation.ts valida objetos ja decodificados de JSON. Esse modulo nao registra rotas nem acessa PostgreSQL. A rota POST /tasks ja utiliza esta validacao na fabrica Fastify quando TaskRepository e injetado; a composicao operacional no entrypoint ainda esta pendente. Exemplos HTTP estao em [Criacao de tarefas](task-creation.md).

## Estrutura estrita

Aceita somente title (string obrigatoria) e description (string opcional). Nao converte tipos, nao remove campos extras e nao insere defaults no corpo recebido.

Exemplos rejeitados:

- {"title":123}: numero nao e convertido em string.
- {"title":"Exemplo","description":null}: null explicito nao e permitido.
- {"title":"Exemplo","id":"uuid"}: campo controlado pelo sistema.
- {"title":"Exemplo","status":"pending"} e {"title":"Exemplo","createdAt":null}.
- {"title":"Exemplo","priority":"high"}: qualquer campo desconhecido e rejeitado.

## Trim e descricao

Entrada: {"title":"  Exemplo  ","description":"  texto  "}

Resultado interno: {"title":"Exemplo","description":"  texto  "}

Descricao ausente produz description: null no resultado interno, sem alterar a entrada. Descricao vazia permanece "". Uma descricao somente de espacos e aceita dentro do limite. O modulo retorna um novo objeto e lanca TaskValidationError para entradas invalidas; nao produz respostas HTTP diretamente; a rota traduz suas falhas, e o handler central ja produz as respostas de erro. O contrato publico esta em [Criacao de tarefas](task-creation.md#respostas-de-erro).

## Pontos de codigo Unicode

title deve ter 1 a 120 pontos de codigo apos String.prototype.trim; description deve ter no maximo 500, sem trim. Nao ha normalizacao Unicode.

- 120 emojis U+1F600 no titulo: aceito; 121: rejeitado.
- 500 emojis U+1F600 na descricao: aceito; 501: rejeitado.
- Um emoji suplementar conta um ponto de codigo, embora ocupe duas unidades UTF-16.
- A sequencia U+0065 U+0301 conta dois pontos de codigo. Sessenta repeticoes cabem no titulo, sem conversao para U+00E9.
- Espacos internos do titulo sao preservados; espacos nas extremidades da descricao contam no limite.

Execute npm.cmd test para validar os cenarios. Os testes cobrem estrutura, campos proibidos, ausencia/null/vazio, tipos invalidos, trim, emojis e limites.
