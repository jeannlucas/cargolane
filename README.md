# cargolane

**[Português](#português)** · **[English](#english)**

Marketplace de fretes construído para demonstrar microsserviços, gRPC e
mensageria sob um problema real de concorrência.

---

# Português

Embarcadores publicam cargas; transportadoras competem para reservá-las.
O objetivo não é um CRUD com uma fila decorativa: é resolver bem um
problema difícil e deixar a solução legível.

Este é o **Marco 2**, com três serviços: `catalog` (a fonte da verdade sobre
cargas, e quem decide a disputa), `bidding` (cotações e orquestração da
aceitação) e `gateway` (a porta HTTP pública — REST para fora, gRPC para
dentro). Veja [O que ainda não existe](#o-que-ainda-não-existe).

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
pnpm test
```

**Estado honesto do que está acima, hoje:**

- `docker compose up -d` sobe Postgres, MongoDB e LocalStack (SQS). Ele
  **não** sobe nenhum dos três serviços (`catalog`, `bidding`, `gateway`):
  ainda não há Dockerfile nem entrada no compose para nenhum deles. Cada
  serviço é iniciado direto pelo Node, como abaixo.
- `pnpm test`, na raiz, roda a suíte dos três pacotes (`pnpm -r test`)
  contra containers Postgres reais criados sob demanda via Testcontainers.
  Não depende do `docker compose` estar de pé: cada arquivo de teste sobe e
  derruba o próprio container, inclusive os testes do `gateway` que
  precisam do `catalog` e do `bidding` reais de pé ao mesmo tempo (ver
  `services/gateway/test/full-flow.e2e.spec.ts`).
- Para compilar e rodar os três serviços à mão, com o Postgres do
  `docker compose` de pé (os três podem apontar para o mesmo banco: cada um
  só enxerga as próprias tabelas, via `entities` do TypeORM):

  ```bash
  pnpm --filter catalog build
  pnpm --filter bidding build
  pnpm --filter gateway build

  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    CATALOG_GRPC_URL=127.0.0.1:50051 \
    node services/catalog/dist/main.js

  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
    node services/bidding/dist/main.js

  CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
    GATEWAY_HTTP_PORT=3000 node services/gateway/dist/main.js
  ```

  Cada comando acima é um processo separado, no seu próprio terminal.

### Vendo a disputa acontecer

Dois scripts de demonstração existem, um para cada camada da API. Nenhum dos
dois afirma nada: a saída é para leitura humana, e as garantias reais vivem
na suíte de testes (ver [Cobertura de testes](#cobertura-de-testes)). Os
dois ficam fora do build de produção.

**Pelo gRPC do `catalog`, direto** — útil para ver o mecanismo central
isolado do resto do sistema. gRPC não é HTTP: não dá para exercitar esta
API com `curl` nem com o navegador, por isso o script fala gRPC. Com o
`catalog` rodando:

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

**Pela API REST pública do `gateway`** — o mesmo mecanismo, mas visto de
onde o mundo externo o vê: sem `.proto`, sem cliente gRPC, só requisições
HTTP. Com os três serviços rodando (catalog, bidding e gateway, nessa
ordem):

```bash
pnpm --filter gateway demo
```

Ele publica uma carga, cota com várias transportadoras, dispara todas
aceitando ao mesmo tempo por `POST /loads/:id/accept`, e confirma pela
própria API (`GET /loads/:id`) que quem o `catalog` registrou como dono da
carga é exatamente quem o `gateway` respondeu como vencedor:

```
fired    5 in 34ms
won      1
lost     4
  4 x HTTP 409

winner   carrier-1
status   won
losers   4 (reported by the gateway response itself)
```

Ajuste a escala com `DEMO_CARRIERS=20 pnpm --filter gateway demo`.

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
Isto é o que existe hoje, somando os três pacotes: **95 testes** (38 em
`services/catalog`, 33 em `services/bidding`, 24 em `services/gateway`).

**`services/catalog` (38 testes) — a fonte da verdade sobre cargas:**

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

**`services/bidding` (33 testes) — cotações e orquestração da aceitação:**

- **Validação e ciclo de vida da cotação** (`test/quote.validation.spec.ts`,
  `test/quote.entity.spec.ts`, `test/quote.submit.spec.ts`): invariantes de
  domínio (preço e ETA positivos, `carrierId` não vazio), a restrição de
  unicidade de `(loadId, carrierId)` contra um Postgres real, e o
  desempate por `created_at` na listagem.
- **`test/quote.accept.spec.ts` — orquestração real contra o catalog real**,
  nenhum dos dois lados mockado: aceitar sem ter cotado falha sem chamar o
  catalog; a vencedora fica `won` e as demais `lost`; quando o catalog
  recusa a reserva, nenhuma cotação muda de status. O teste central
  (`"duas aceitacoes simultaneas..."`) repete a mesma disputa do catalog uma
  camada acima e **amarra a decisão à origem**: o `carrier_id` que o
  catalog registrou como dono da carga precisa ser o mesmo cuja cotação
  ficou `WON` no bidding — sem essa amarração, o teste provaria só que uma
  das duas venceu, não que foi o `UPDATE` condicional do catalog quem
  decidiu.

**`services/gateway` (24 testes) — a porta HTTP pública:**

- **`test/loads.e2e.spec.ts` e `test/quotes.e2e.spec.ts`**: tradução
  REST-para-gRPC para `POST /loads`, `GET /loads/:id`, `GET /loads`,
  `POST /loads/:id/quotes`, `GET /loads/:id/quotes` e
  `POST /loads/:id/accept`, incluindo o filtro de erro gRPC-para-HTTP
  (`INVALID_ARGUMENT`→400, `NOT_FOUND`→404, `ALREADY_EXISTS`/
  `FAILED_PRECONDITION`→409, código não mapeado→500 genérico, sem vazar
  endereço/porta interna). Boa parte desses testes roda contra uma segunda
  instância do gateway apontada para uma porta inalcançável
  (`127.0.0.1:1`), para provar que a validação de forma (`ValidationPipe`)
  acontece no próprio gateway — sem isso, um 400 que também é invariante de
  domínio do catalog/bidding passaria mesmo com o `ValidationPipe`
  removido, mascarando a lacuna (achado real de sabotagem durante o
  desenvolvimento deste marco).
- **`test/full-flow.e2e.spec.ts` — o teste que fecha o Marco 2**: catalog,
  bidding e gateway de pé ao mesmo tempo, cada um com seu próprio Postgres,
  exercitados só pela API HTTP pública. Publica uma carga, três
  transportadoras cotam, as três aceitam ao mesmo tempo (as três
  requisições HTTP são disparadas antes de qualquer uma responder). A prova
  de que o *servidor* processou as três em sobreposição real — não só que o
  cliente as disparou sem esperar resposta — vem de dois contadores de pico
  de execuções em andamento, um de cada lado da chamada gRPC entre gateway
  e bidding (`peakAcceptInFlight` no gateway, `peakBiddingAcceptInFlight`
  no bidding): os dois precisam chegar a 3, porque um mutex em qualquer um
  dos dois lados derrubaria o contador correspondente para 1 sem mudar o
  resultado HTTP. Essa checagem substitui uma versão anterior que comparava
  janelas de tempo capturadas no cliente antes/depois de cada requisição —
  descartada por ser quase tautológica (as janelas sempre começam a poucos
  milissegundos de distância, não importa o que o servidor faça depois).
  Exatamente uma requisição recebe `200`, as outras duas `409`; a carga
  fica `reserved`; e o `carrierId` que `GET /loads/:id` devolve é conferido
  contra a cotação que ficou `won` — a mesma amarração à origem do teste do
  bidding, agora provada pela API pública inteira.

**Não coberto, deliberadamente fora do escopo deste marco:**

- O padrão outbox e qualquer fila de mensagens: o `catalog` ainda não
  publica `LoadReserved` nem nenhum outro evento.
- Testes unitários isolados do Postgres. Todo teste aqui fala com um banco
  real de propósito, porque o comportamento que importa (o `UPDATE`
  condicional, as restrições de unicidade) é exatamente o que um mock não
  reproduz.
- Testes de contrato gerados a partir dos `.proto`.
- Autenticação/autorização na API do gateway: qualquer chamador pode
  publicar cargas, cotar e aceitar em nome de qualquer `shipperId`/
  `carrierId`. Não é o problema que este marco resolve.
- Nenhum pipeline de CI roda isso automaticamente. Hoje é `pnpm test`, na
  raiz, na mão.

## O que ainda não existe

Este repositório contém três dos quatro serviços. Falta:

- `tracking` — a máquina de estados pós-reserva e os eventos de
  rastreamento (MongoDB). Não construído.
- A tabela **outbox** e o publisher que permitiriam ao `catalog` publicar
  `LoadReserved` atomicamente junto com o `UPDATE` da reserva. Não
  construído: hoje o `ReserveLoad` apenas altera a linha no Postgres.
- A fiação da **fila** SQS. O LocalStack sobe no `docker compose`, mas nada
  publica nem consome dele ainda.

E, independente de serviço, ainda não há Dockerfile nem entrada no compose
para `catalog`, `bidding` ou `gateway` — o `docker compose up -d` de hoje
sobe só a infraestrutura (Postgres, MongoDB, LocalStack), nunca o código do
projeto. Nenhum pipeline de CI existe.

Este é o Marco 2 de 4.

---

# English

Shippers publish loads; carriers compete to reserve them. The goal is not
a CRUD with a decorative queue: it is to solve one hard problem well and
leave the solution readable.

This is **Milestone 2**, with three services: `catalog` (the source of
truth for loads, and the one that decides the dispute), `bidding` (quotes
and acceptance orchestration), and `gateway` (the public HTTP entry point —
REST in, gRPC out). See [What doesn't exist yet](#what-doesnt-exist-yet).

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
pnpm test
```

**Honest state of the above today:**

- `docker compose up -d` starts Postgres, MongoDB, and LocalStack (SQS). It
  does **not** start any of the three services (`catalog`, `bidding`,
  `gateway`): there is no Dockerfile and no compose entry for any of them
  yet. Each service is started directly with Node, as below.
- `pnpm test`, at the repository root, runs the suite for all three
  packages (`pnpm -r test`) against real Postgres containers spun up on
  demand via Testcontainers. It does not depend on `docker compose` being
  up: each test file starts and tears down its own container, including the
  `gateway` tests that need `catalog` and `bidding` for real, at the same
  time (see `services/gateway/test/full-flow.e2e.spec.ts`).
- To build and run all three services by hand, with the `docker compose`
  Postgres up (all three can point at the same database: each only sees its
  own tables, via TypeORM `entities`):

  ```bash
  pnpm --filter catalog build
  pnpm --filter bidding build
  pnpm --filter gateway build

  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    CATALOG_GRPC_URL=127.0.0.1:50051 \
    node services/catalog/dist/main.js

  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
    node services/bidding/dist/main.js

  CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
    GATEWAY_HTTP_PORT=3000 node services/gateway/dist/main.js
  ```

  Each command above is a separate process, in its own terminal.

### Seeing the race happen

Two demo scripts exist, one for each layer of the API. Neither asserts
anything: the output is for humans to read, and the real guarantees live in
the test suite (see [Test coverage](#test-coverage)). Both are excluded
from the production build.

**Against `catalog`'s gRPC directly** — useful to see the central mechanism
in isolation from the rest of the system. gRPC is not HTTP: you cannot
exercise this API with `curl` or a browser, which is why this script speaks
gRPC. With `catalog` running:

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

**Through the `gateway`'s public REST API** — the same mechanism, seen from
where the outside world actually sees it: no `.proto`, no gRPC client, just
HTTP requests. With all three services running (catalog, bidding, then
gateway, in that order):

```bash
pnpm --filter gateway demo
```

It publishes a load, has several carriers quote it, fires all of them
accepting it at once through `POST /loads/:id/accept`, and confirms through
the API itself (`GET /loads/:id`) that whoever `catalog` recorded as the
load's owner is exactly who `gateway` reported as the winner:

```
fired    5 in 34ms
won      1
lost     4
  4 x HTTP 409

winner   carrier-1
status   won
losers   4 (reported by the gateway response itself)
```

Scale it with `DEMO_CARRIERS=20 pnpm --filter gateway demo`.

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
what exists today, across the three packages: **95 tests** (38 in
`services/catalog`, 33 in `services/bidding`, 24 in `services/gateway`).

**`services/catalog` (38 tests) — the source of truth for loads:**

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

**`services/bidding` (33 tests) — quotes and acceptance orchestration:**

- **Quote validation and lifecycle** (`test/quote.validation.spec.ts`,
  `test/quote.entity.spec.ts`, `test/quote.submit.spec.ts`): domain
  invariants (positive price and ETA, non-empty `carrierId`), the
  `(loadId, carrierId)` uniqueness constraint against a real Postgres, and
  tie-breaking by `created_at` in the listing.
- **`test/quote.accept.spec.ts` — real orchestration against a real
  catalog**, neither side mocked: accepting without a quote fails without
  calling the catalog; the winner ends up `won` and the rest `lost`; when
  the catalog refuses the reservation, no quote changes status. The central
  test (`"duas aceitacoes simultaneas..."`) repeats the catalog's own race
  one layer up and **ties the decision to its origin**: the `carrier_id`
  the catalog recorded as the load's owner has to be the same one whose
  quote ended up `WON` in bidding — without that link, the test would only
  prove that one of the two won, not that the catalog's conditional
  `UPDATE` was the one deciding it.

**`services/gateway` (24 tests) — the public HTTP entry point:**

- **`test/loads.e2e.spec.ts` and `test/quotes.e2e.spec.ts`**: REST-to-gRPC
  translation for `POST /loads`, `GET /loads/:id`, `GET /loads`,
  `POST /loads/:id/quotes`, `GET /loads/:id/quotes`, and
  `POST /loads/:id/accept`, including the gRPC-to-HTTP error filter
  (`INVALID_ARGUMENT`→400, `NOT_FOUND`→404, `ALREADY_EXISTS`/
  `FAILED_PRECONDITION`→409, unmapped code→generic 500, without leaking any
  internal address/port). Much of that coverage runs against a second
  gateway instance pointed at an unreachable address (`127.0.0.1:1`), to
  prove that shape validation (`ValidationPipe`) happens in the gateway
  itself — without that, a 400 that is also a catalog/bidding domain
  invariant would still pass with the `ValidationPipe` removed, masking the
  gap (an actual sabotage finding from building this milestone).
- **`test/full-flow.e2e.spec.ts` — the test that closes Milestone 2**:
  catalog, bidding, and gateway up at the same time, each with its own
  Postgres, exercised only through the public HTTP API. It publishes a
  load, has three carriers quote it, and has all three accept at once (the
  three HTTP requests are fired before any of them responds). Proof that
  the *server* actually processed the three in real overlap — not just that
  the client fired them without waiting — comes from two peak in-flight
  counters, one on each side of the gRPC call between gateway and bidding
  (`peakAcceptInFlight` in the gateway, `peakBiddingAcceptInFlight` in
  bidding): both have to reach 3, because a mutex on either side would drop
  the corresponding counter to 1 without changing the HTTP outcome. This
  check replaces an earlier version that compared client-captured
  before/after time windows — dropped for being nearly tautological (the
  windows always start a few milliseconds apart no matter what the server
  does afterward). Exactly one request gets `200`, the other two `409`; the
  load ends up `reserved`; and the `carrierId` that `GET /loads/:id`
  returns is checked against the quote that ended up `won` — the same
  tie-to-origin proof as the bidding test, now proven through the whole
  public API.

**Not covered, deliberately out of scope for this milestone:**

- The outbox pattern and any message queue: `catalog` does not publish
  `LoadReserved` or any other event yet.
- Unit tests isolated from Postgres. Every test here talks to a real
  database on purpose, because the behavior that matters — the conditional
  `UPDATE`, the uniqueness constraints — is exactly what a mock does not
  reproduce.
- Contract tests generated from the `.proto` files.
- Authentication/authorization on the gateway API: any caller can publish
  loads, quote, and accept on behalf of any `shipperId`/`carrierId`. Not the
  problem this milestone solves.
- No CI pipeline runs any of this automatically. Today it is `pnpm test`,
  at the repository root, by hand.

## What doesn't exist yet

This repository holds three of the four services. What's missing:

- `tracking` — the post-reservation state machine and tracking events
  (MongoDB). Not built.
- The **outbox** table and publisher that would let `catalog` publish
  `LoadReserved` atomically with the reservation `UPDATE`. Not built:
  `ReserveLoad` today only changes the row in Postgres.
- The SQS **queue** wiring itself. LocalStack runs in `docker compose`, but
  nothing publishes to or consumes from it yet.

And, independent of any single service, there is still no Dockerfile and no
compose entry for `catalog`, `bidding`, or `gateway` — today's
`docker compose up -d` starts only infrastructure (Postgres, MongoDB,
LocalStack), never the project's own code. No CI pipeline exists.

This is Milestone 2 of 4.
