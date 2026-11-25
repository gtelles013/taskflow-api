# Proposal

## Why

A TaskFlow API precisa criar tarefas com um contrato HTTP previsivel e persistencia duravel. Esta primeira capacidade estabelece validacao estrita e respostas verificaveis antes da implementacao.

## What Changes

- Introduzir POST /tasks com title obrigatorio, trim e limite de 1 a 120 pontos de codigo Unicode.
- Aceitar description opcional de ate 500 pontos de codigo, preservando espacos; ausencia vira NULL e null e rejeitado.
- Rejeitar campos desconhecidos, incluindo id, status e createdAt.
- Persistir no PostgreSQL com UUID, status pending e createdAt gerados pelo sistema; permitir titulos duplicados.
- Retornar a tarefa completa com 201 apos persistir; usar 400 para entradas invalidas, 503 para indisponibilidade identificavel e 500 para falhas inesperadas.
- Excluir autenticacao, prioridade, prazo e outros endpoints desta versao.

## Capabilities

### New Capabilities

- `task-creation`: criacao de tarefas com validacao, campos gerados pelo sistema, persistencia e contrato de erros.

### Modified Capabilities

Nenhuma; nao existem specs anteriores.

## Impact

- Novo servidor Node.js/TypeScript com Fastify, acesso PostgreSQL e testes Vitest.
- Novos modulos HTTP, validacao, repositorio, migracao e configuracao de banco/testes.
- package.json e tsconfig.json precisarao de ajustes na implementacao; hoje nao ha codigo de aplicacao nem testes funcionais.
- Sem alteracoes de codigo nesta proposta.

