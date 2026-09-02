# cargolane

A freight marketplace built to demonstrate microservices, gRPC, and
messaging under a realistic concurrency problem, not a CRUD with a
decorative queue. Shippers publish loads; carriers compete to reserve them.
The full design rationale lives in
[`docs/superpowers/specs/2026-09-02-cargolane-design.md`](docs/superpowers/specs/2026-09-02-cargolane-design.md).

This is **Milestone 1**: the `catalog` service only. See
[What doesn't exist yet](#what-doesnt-exist-yet) below.

## The core problem, and the solution

Two carriers can try to accept the same load in the same instant. Exactly
one has to win; the other has to fail cleanly, with no double-booked
freight and no lost update.

The obvious-looking fixes are both wrong here. A distributed lock (or a
Redis-based one) adds an entire extra system, a network round trip, and a
new failure mode (what happens when the lock service itself is
unavailable?) to protect a write that a relational database already
serializes for free. It would be solving the problem the database already
solves, badly.

The actual fix is a single conditional `UPDATE`, inside the local
transaction that owns the row:

```sql
UPDATE loads SET status = 'reserved', carrier_id = $1
WHERE id = $2 AND status = 'open'
```

One transaction's `UPDATE` affects exactly one row and commits. Every
other concurrent transaction targeting the same load affects zero rows,
because by the time it runs, `status` is no longer `'open'` — Postgres's
own row-level locking during the `UPDATE` serializes the contenders. Zero
rows affected is treated as "not open anymore" and surfaces to the caller
as gRPC `FAILED_PRECONDITION`. No lock table, no `SELECT ... FOR UPDATE`
held across a network call, no external coordination service — the
guarantee is the one the database already gives an `UPDATE ... WHERE`.

This is proven under real concurrency, not asserted: see
[Test coverage](#test-coverage) below.

## Running it

```bash
docker compose up -d
pnpm --filter catalog test
```

**Honest state of the above today:**
- `docker compose up -d` starts Postgres, MongoDB, and LocalStack (SQS).
  It does **not** start the `catalog` service itself — there is no
  Dockerfile for it yet, and no compose entry for it. The service is
  started directly with Node (see below); containerizing it is not yet
  done.
- `pnpm --filter catalog test` runs the full test suite against real
  Postgres containers spun up on demand via Testcontainers — it does not
  depend on `docker compose` being up first (each test file starts and
  tears down its own Postgres container).
- To build and run the service by hand, once `docker compose up -d
  postgres` is up:
  ```bash
  pnpm --filter catalog build
  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
    node services/catalog/dist/main.js
  ```

### Seeing the race happen

gRPC is not HTTP: you cannot exercise this API with `curl` or a browser.
With the service running (see above), a demo script drives it end to end
through a real gRPC client:

```bash
pnpm --filter catalog demo
```

It publishes a load, fires 50 carriers accepting it simultaneously, and
prints who won and how the other 49 were rejected:

```
disparadas   50 em 38ms
venceram     1
perderam     49
  49 x FAILED_PRECONDITION (9)

vencedora    carrier-0
status       reserved
```

Scale it with `DEMO_CARRIERS=200 pnpm --filter catalog demo`.

**This script asserts nothing.** Its output is for humans to read; the
guarantees live in the test suite. It exists so that someone evaluating
this repository can watch the central mechanism work without reading
Jest output, and it is excluded from the production build.

### Enabling the pre-push guard (optional, local convention)

`.githooks/pre-push` refuses to push `main` while the local `dev` is ahead
of `origin/dev`, to prevent the integration branch on GitHub from silently
falling behind production. It is not wired in by default; enable it with:

```bash
git config core.hooksPath .githooks
```

Escape hatch: `git push --no-verify`.

## Test coverage

Per the spec (§9), coverage is reported honestly instead of chasing a
numeric badge. This is what exists today, in `services/catalog`:

**Covered:**
- **The concurrency test that defines the project**
  (`test/load.reserve.spec.ts`): 50 carriers call `ReserveLoad` on the
  same open load at once. Exactly one wins, the other 49 fail with
  `LoadNotOpenError`/`FAILED_PRECONDITION`, and the row ends up owned by
  exactly one carrier. The test pre-warms 50 real Postgres connections
  (`poolSize: 50` plus a warm-up `SELECT 1` on each) before firing the 50
  reservations concurrently — without that, TypeORM's default pool size
  (10) queues the calls and the "concurrent" test runs mostly
  sequentially, without the test noticing. This was verified by
  sabotage: with the `AND status = 'open'` guard removed from the
  `UPDATE`, the same test fails with 50 winners instead of 1, confirming
  the test actually exercises the race and isn't just asserting an
  invariant that would hold anyway under serialized execution.
- **Repository-level integration tests** against a real Postgres
  container (Testcontainers), never a mock: `create`, `findById`, `list`
  (route filtering, ordering, limit clamping to `[1, 100]`), `reserve`
  (not-found vs. not-open, already-reserved), and `expireOverdue`.
- **gRPC contract/integration tests** (`test/catalog.grpc.spec.ts`): the
  full Nest microservice is started over gRPC against a real Postgres
  container, and a real gRPC client exercises `PublishLoad`, `GetLoad`,
  `ListLoads`, and `ReserveLoad`, including the domain-error-to-gRPC-code
  translation (`NOT_FOUND`, `FAILED_PRECONDITION`).
- **The expiration job** (`test/load.expiration.job.spec.ts`,
  `test/load.expiration.spec.ts`): the repository method
  (`expireOverdue`) is tested directly against Postgres, and the job
  wiring itself is tested separately — that `LoadExpirationJob` calls
  `expireOverdue` and logs, that a rejected repository call is caught and
  logged instead of crashing the process, and that the job is actually
  registered as a provider on `AppModule` (this last one was confirmed by
  sabotage too: removing the provider from `app.module.ts` fails the
  wiring test).

**Not covered / explicitly out of scope for this milestone:**
- Input validation at the RPC boundary (planned as a layering decision,
  not implemented yet).
- The outbox pattern and any message queue — `catalog` does not yet
  publish `LoadReserved` or any other event.
- Unit tests isolated from Postgres. Every test here talks to a real
  database on purpose (per spec §9: the behavior that matters — the
  conditional `UPDATE`, uniqueness — is exactly what a mock doesn't
  reproduce), so there is no mocked-repository unit test suite.
- Contract tests generated from the `.proto` files, and end-to-end tests
  through a gateway — there is no gateway yet.
- No CI pipeline runs any of this automatically yet; today it is
  `pnpm --filter catalog test`, run by hand.

## What doesn't exist yet

This repository currently contains one service. Per the design (§4, §7),
the full system is four components plus an outbox and a queue:

- `gateway` — the single HTTP entry point (REST in, gRPC out). Not built.
- `bidding` — quotes, acceptance orchestration, loser notification. Not
  built.
- `tracking` — the post-reservation state machine and tracking events
  (MongoDB). Not built.
- The **outbox** table and publisher that would let `catalog` publish
  `LoadReserved` atomically with the reservation `UPDATE`. Not built —
  `ReserveLoad` today only changes the row in Postgres.
- The SQS **queue** wiring itself (LocalStack runs in `docker compose`,
  but nothing publishes to or consumes from it yet).

This is Milestone 1 of 4.
