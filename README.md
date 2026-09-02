# cargolane

**[Português](#português)** · **[English](#english)**

Marketplace de fretes construído para demonstrar microsserviços, gRPC e
mensageria sob um problema real de concorrência.

---

# Português

Embarcadores publicam cargas; transportadoras competem para reservá-las.
O objetivo não é um CRUD com uma fila decorativa: é resolver bem um
problema difícil e deixar a solução legível.

Este é o **Marco 1**, com o serviço `catalog` apenas. Veja
[O que ainda não existe](#o-que-ainda-não-existe).

## O problema central, e a solução

Duas transportadoras podem tentar aceitar a mesma carga no mesmo instante.
Exatamente uma precisa vencer; a outra precisa falhar de forma limpa, sem
frete duplo-reservado e sem perda de escrita.

As soluções que parecem óbvias estão erradas aqui. Um lock distribuído (ou
um baseado em Redis) acrescenta um sistema inteiro, uma ida e volta de
rede e um novo modo de falha — o que acontece quando o serviço de lock cai?
— para proteger uma escrita que o banco relacional já serializa de graça.
Seria resolver mal um problema que o banco já resolve.

A solução real é um único `UPDATE` condicional, dentro da transação local
que é dona da linha:

```sql
UPDATE loads SET status = 'reserved', carrier_id = $1
WHERE id = $2 AND status = 'open'
```

O `UPDATE` de uma transação afeta exatamente uma linha e commita. Toda
transação concorrente mirando a mesma carga afeta zero linhas, porque
quando ela executa o `status` já não é `'open'` — o próprio lock de linha
do Postgres durante o `UPDATE` serializa os concorrentes. Zero linhas
afetadas é tratado como "não está mais aberta" e chega ao chamador como
`FAILED_PRECONDITION` do gRPC. Sem tabela de lock, sem `SELECT ... FOR
UPDATE` mantido através de uma chamada de rede, sem serviço externo de
coordenação: a garantia é a que o banco já dá a um `UPDATE ... WHERE`.

Isso é **provado sob concorrência real**, não afirmado. Veja
[Cobertura de testes](#cobertura-de-testes).

## Como rodar

```bash
docker compose up -d
pnpm --filter catalog test
```

**Estado honesto do que está acima, hoje:**

- `docker compose up -d` sobe Postgres, MongoDB e LocalStack (SQS). Ele
  **não** sobe o serviço `catalog`: ainda não há Dockerfile nem entrada no
  compose para ele. O serviço é iniciado direto pelo Node, como abaixo.
- `pnpm --filter catalog test` roda a suíte inteira contra containers
  Postgres reais criados sob demanda via Testcontainers. Não depende do
  `docker compose` estar de pé: cada arquivo de teste sobe e derruba o
  próprio container.
- Para compilar e rodar o serviço à mão, com o Postgres de pé:

  ```bash
  pnpm --filter catalog build
  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    node services/catalog/dist/main.js
  ```

### Vendo a disputa acontecer

gRPC não é HTTP: não dá para exercitar esta API com `curl` nem com o
navegador. Com o serviço rodando, um script de demonstração conduz o
sistema de ponta a ponta por um cliente gRPC real:

```bash
pnpm --filter catalog demo
```

Ele publica uma carga, dispara 50 transportadoras aceitando ao mesmo tempo,
e imprime quem venceu e como as outras 49 foram rejeitadas:

```
fired    50 in 49ms
won      1
lost     49
  49 x FAILED_PRECONDITION (9)

winner   carrier-0
status   reserved
```

Ajuste a escala com `DEMO_CARRIERS=200 pnpm --filter catalog demo`.

**Este script não afirma nada.** A saída é para leitura humana; as
garantias vivem na suíte de testes. Ele existe para que alguém avaliando
este repositório veja o mecanismo central funcionar sem ler saída de Jest,
e fica fora do build de produção.

### Ativando o hook de pre-push (convenção local, opcional)

`.githooks/pre-push` recusa o push de `main` enquanto a `dev` local estiver
à frente de `origin/dev`, para impedir que a branch de integração no GitHub
fique silenciosamente atrás da produção. Não vem ativo por padrão:

```bash
git config core.hooksPath .githooks
```

Escape: `git push --no-verify`.

## Cobertura de testes

Cobertura é relatada honestamente, em vez de perseguir um selo numérico.
Isto é o que existe hoje em `services/catalog`.

**Coberto:**

- **O teste de concorrência que define o projeto**
  (`test/load.reserve.spec.ts`): 50 transportadoras chamam `ReserveLoad` na
  mesma carga aberta ao mesmo tempo. Exatamente uma vence, as outras 49
  falham com `FAILED_PRECONDITION`, e a linha termina pertencendo a uma só.
  O teste pré-aquece 50 conexões reais do Postgres (`poolSize: 50` mais um
  `SELECT 1` em cada) antes de disparar as reservas. Sem isso, o pool
  padrão do TypeORM (10) enfileira as chamadas e o teste "concorrente" roda
  quase sequencialmente, sem avisar ninguém. Verificado por sabotagem: com
  a guarda `AND status = 'open'` removida do `UPDATE`, o mesmo teste falha
  com 50 vencedoras em vez de 1, confirmando que ele exercita a corrida de
  verdade e não apenas um invariante que valeria mesmo em execução
  serializada.
- **Testes de integração no repositório** contra um Postgres real
  (Testcontainers), nunca um mock: `create`, `findById`, `list` (filtro por
  rota, ordenação, limite normalizado para `[1, 100]`), `reserve`
  (inexistente x não-aberta x já reservada) e `expireOverdue`.
- **Testes de contrato e integração gRPC** (`test/catalog.grpc.spec.ts`): o
  microsserviço Nest inteiro sobe por gRPC contra um Postgres real, e um
  cliente gRPC real exercita `PublishLoad`, `GetLoad`, `ListLoads` e
  `ReserveLoad`, incluindo a tradução de erro de domínio para código gRPC
  (`NOT_FOUND`, `FAILED_PRECONDITION`).
- **O job de expiração** (`test/load.expiration.job.spec.ts` e
  `test/load.expiration.spec.ts`): o método do repositório é testado direto
  contra o Postgres, e a fiação do job é testada à parte — que
  `LoadExpirationJob` chama `expireOverdue` e registra o resultado, que uma
  rejeição do repositório é capturada e logada em vez de derrubar o
  processo, e que o job está de fato registrado como provider no
  `AppModule`. Este último também foi confirmado por sabotagem: remover o
  provider do módulo faz o teste de fiação falhar.

**Não coberto, deliberadamente fora do escopo deste marco:**

- Validação de entrada na fronteira dos RPCs. É uma decisão de camada
  (gateway ou serviço), ainda não tomada.
- O padrão outbox e qualquer fila de mensagens: o `catalog` ainda não
  publica `LoadReserved` nem nenhum outro evento.
- Testes unitários isolados do Postgres. Todo teste aqui fala com um banco
  real de propósito, porque o comportamento que importa (o `UPDATE`
  condicional, as restrições de unicidade) é exatamente o que um mock não
  reproduz.
- Testes de contrato gerados a partir dos `.proto`, e testes ponta a ponta
  através de um gateway, que ainda não existe.
- Nenhum pipeline de CI roda isso automaticamente. Hoje é
  `pnpm --filter catalog test`, na mão.

## O que ainda não existe

Este repositório contém um serviço. O sistema completo são quatro
componentes, mais um outbox e uma fila:

- `gateway` — a única porta de entrada HTTP (REST para fora, gRPC para
  dentro). Não construído.
- `bidding` — cotações, orquestração da aceitação e notificação de quem
  perdeu. Não construído.
- `tracking` — a máquina de estados pós-reserva e os eventos de
  rastreamento (MongoDB). Não construído.
- A tabela **outbox** e o publisher que permitiriam ao `catalog` publicar
  `LoadReserved` atomicamente junto com o `UPDATE` da reserva. Não
  construído: hoje o `ReserveLoad` apenas altera a linha no Postgres.
- A fiação da **fila** SQS. O LocalStack sobe no `docker compose`, mas nada
  publica nem consome dele ainda.

Este é o Marco 1 de 4.

---

# English

Shippers publish loads; carriers compete to reserve them. The goal is not
a CRUD with a decorative queue: it is to solve one hard problem well and
leave the solution readable.

This is **Milestone 1**, the `catalog` service only. See
[What doesn't exist yet](#what-doesnt-exist-yet).

## The core problem, and the solution

Two carriers can try to accept the same load in the same instant. Exactly
one has to win; the other has to fail cleanly, with no double-booked
freight and no lost update.

The obvious-looking fixes are both wrong here. A distributed lock (or a
Redis-based one) adds an entire extra system, a network round trip, and a
new failure mode — what happens when the lock service itself is
unavailable? — to protect a write that a relational database already
serializes for free. It would be solving badly a problem the database
already solves.

The actual fix is a single conditional `UPDATE`, inside the local
transaction that owns the row:

```sql
UPDATE loads SET status = 'reserved', carrier_id = $1
WHERE id = $2 AND status = 'open'
```

One transaction's `UPDATE` affects exactly one row and commits. Every other
concurrent transaction targeting the same load affects zero rows, because
by the time it runs `status` is no longer `'open'` — Postgres's own
row-level locking during the `UPDATE` serializes the contenders. Zero rows
affected is treated as "not open anymore" and surfaces to the caller as
gRPC `FAILED_PRECONDITION`. No lock table, no `SELECT ... FOR UPDATE` held
across a network call, no external coordination service: the guarantee is
the one the database already gives an `UPDATE ... WHERE`.

This is **proven under real concurrency**, not asserted. See
[Test coverage](#test-coverage).

## Running it

```bash
docker compose up -d
pnpm --filter catalog test
```

**Honest state of the above today:**

- `docker compose up -d` starts Postgres, MongoDB, and LocalStack (SQS). It
  does **not** start the `catalog` service itself: there is no Dockerfile
  and no compose entry for it yet. The service is started directly with
  Node, as below.
- `pnpm --filter catalog test` runs the full suite against real Postgres
  containers spun up on demand via Testcontainers. It does not depend on
  `docker compose` being up: each test file starts and tears down its own
  container.
- To build and run the service by hand, with Postgres up:

  ```bash
  pnpm --filter catalog build
  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    node services/catalog/dist/main.js
  ```

### Seeing the race happen

gRPC is not HTTP: you cannot exercise this API with `curl` or a browser.
With the service running, a demo script drives it end to end through a real
gRPC client:

```bash
pnpm --filter catalog demo
```

It publishes a load, fires 50 carriers accepting it at once, and prints who
won and how the other 49 were rejected:

```
fired    50 in 49ms
won      1
lost     49
  49 x FAILED_PRECONDITION (9)

winner   carrier-0
status   reserved
```

Scale it with `DEMO_CARRIERS=200 pnpm --filter catalog demo`.

**This script asserts nothing.** Its output is for humans to read; the
guarantees live in the test suite. It exists so that someone evaluating
this repository can watch the central mechanism work without reading Jest
output, and it is excluded from the production build.

### Enabling the pre-push guard (optional, local convention)

`.githooks/pre-push` refuses to push `main` while the local `dev` is ahead
of `origin/dev`, to prevent the integration branch on GitHub from silently
falling behind production. It is not wired in by default:

```bash
git config core.hooksPath .githooks
```

Escape hatch: `git push --no-verify`.

## Test coverage

Coverage is reported honestly instead of chasing a numeric badge. This is
what exists today in `services/catalog`.

**Covered:**

- **The concurrency test that defines the project**
  (`test/load.reserve.spec.ts`): 50 carriers call `ReserveLoad` on the same
  open load at once. Exactly one wins, the other 49 fail with
  `FAILED_PRECONDITION`, and the row ends up owned by exactly one carrier.
  The test pre-warms 50 real Postgres connections (`poolSize: 50` plus a
  warm-up `SELECT 1` on each) before firing the reservations. Without that,
  TypeORM's default pool size (10) queues the calls and the "concurrent"
  test runs mostly sequentially, without the test noticing. Verified by
  sabotage: with the `AND status = 'open'` guard removed from the `UPDATE`,
  the same test fails with 50 winners instead of 1, confirming it actually
  exercises the race rather than asserting an invariant that would hold
  under serialized execution anyway.
- **Repository-level integration tests** against a real Postgres container
  (Testcontainers), never a mock: `create`, `findById`, `list` (route
  filtering, ordering, limit clamping to `[1, 100]`), `reserve` (not-found
  vs. not-open vs. already-reserved), and `expireOverdue`.
- **gRPC contract and integration tests** (`test/catalog.grpc.spec.ts`):
  the full Nest microservice starts over gRPC against a real Postgres
  container, and a real gRPC client exercises `PublishLoad`, `GetLoad`,
  `ListLoads`, and `ReserveLoad`, including domain-error-to-gRPC-code
  translation (`NOT_FOUND`, `FAILED_PRECONDITION`).
- **The expiration job** (`test/load.expiration.job.spec.ts` and
  `test/load.expiration.spec.ts`): the repository method is tested directly
  against Postgres, and the job wiring is tested separately — that
  `LoadExpirationJob` calls `expireOverdue` and logs, that a rejected
  repository call is caught and logged instead of crashing the process, and
  that the job is actually registered as a provider on `AppModule`. That
  last one was confirmed by sabotage too: removing the provider makes the
  wiring test fail.

**Not covered, deliberately out of scope for this milestone:**

- Input validation at the RPC boundary. It is a layering decision (gateway
  or service) that has not been made yet.
- The outbox pattern and any message queue: `catalog` does not publish
  `LoadReserved` or any other event yet.
- Unit tests isolated from Postgres. Every test here talks to a real
  database on purpose, because the behavior that matters — the conditional
  `UPDATE`, the uniqueness constraints — is exactly what a mock does not
  reproduce.
- Contract tests generated from the `.proto` files, and end-to-end tests
  through a gateway, which does not exist yet.
- No CI pipeline runs any of this automatically. Today it is
  `pnpm --filter catalog test`, by hand.

## What doesn't exist yet

This repository holds one service. The full system is four components,
plus an outbox and a queue:

- `gateway` — the single HTTP entry point (REST in, gRPC out). Not built.
- `bidding` — quotes, acceptance orchestration, loser notification. Not
  built.
- `tracking` — the post-reservation state machine and tracking events
  (MongoDB). Not built.
- The **outbox** table and publisher that would let `catalog` publish
  `LoadReserved` atomically with the reservation `UPDATE`. Not built:
  `ReserveLoad` today only changes the row in Postgres.
- The SQS **queue** wiring itself. LocalStack runs in `docker compose`, but
  nothing publishes to or consumes from it yet.

This is Milestone 1 of 4.
