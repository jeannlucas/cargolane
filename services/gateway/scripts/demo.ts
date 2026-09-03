// Interactive walkthrough of the full stack (catalog + bidding + gateway)
// through the public REST API.
//
// services/catalog/scripts/demo.ts already shows the same race in gRPC,
// against the catalog service alone. This script exists because the gateway
// changes what the outside world actually sees: gRPC is gone from the public
// surface, and the dispute between carriers now happens over plain HTTP —
// something curl, a browser, or any HTTP client can drive, with no .proto
// and no gRPC client library required.
//
// It does not replace the tests: nothing here asserts anything, and the
// output is for humans to read. Run `pnpm test` at the repository root for
// the guarantees (87+ tests across catalog, bidding, and gateway).
//
// Usage:
//   1. docker compose up -d
//   2. pnpm --filter catalog build && pnpm --filter bidding build && pnpm --filter gateway build
//   3. DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
//        CATALOG_GRPC_URL=127.0.0.1:50051 \
//        node services/catalog/dist/main.js
//   4. DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \
//        CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
//        node services/bidding/dist/main.js
//   5. CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 \
//        GATEWAY_HTTP_PORT=3000 node services/gateway/dist/main.js
//   6. pnpm --filter gateway demo        (in another terminal)

const BASE_URL = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3000";
const CARRIER_COUNT = Number(process.env.DEMO_CARRIERS ?? 5);

interface LoadResponse {
  id: string;
  origin: string;
  destination: string;
  status: string;
  carrierId: string | null;
}

interface QuoteResponse {
  id: string;
  loadId: string;
  carrierId: string;
  priceCents: number;
  etaHours: number;
  status: string;
}

interface AcceptLoadResponse {
  winningQuote: QuoteResponse;
  losingQuotes: number;
}

interface ApiError {
  statusCode: number;
  message: string;
}

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

function section(title: string): void {
  console.log(`\n${"-".repeat(64)}\n${title}\n${"-".repeat(64)}`);
}

async function main(): Promise<void> {
  console.log(`cargolane HTTP demo — connecting to ${BASE_URL}`);

  section("1. Publish a load (POST /loads)");
  const publish = await postJson<LoadResponse>("/loads", {
    shipperId: "shipper-demo",
    origin: "Maringa/PR",
    destination: "Curitiba/PR",
    weightKg: 12000,
    pickupWindowEnd: new Date(Date.now() + 86_400_000).toISOString(),
    priceCeilingCents: 350_000,
  });
  if (publish.status !== 201) {
    throw new Error(`expected 201 publishing the load, got ${publish.status}`);
  }
  const load = publish.body;
  console.log(`id       ${load.id}`);
  console.log(`route    ${load.origin} -> ${load.destination}`);
  console.log(`status   ${load.status}`);

  section(`2. ${CARRIER_COUNT} carriers quote the load (POST /loads/:id/quotes)`);
  const carriers = Array.from({ length: CARRIER_COUNT }, (_, i) => `carrier-${i}`);
  for (const carrierId of carriers) {
    const quote = await postJson<QuoteResponse>(`/loads/${load.id}/quotes`, {
      carrierId,
      priceCents: 150_000 + i(carrierId) * 5_000,
      etaHours: 20 + i(carrierId),
    });
    if (quote.status !== 201) {
      throw new Error(`expected 201 submitting a quote for ${carrierId}, got ${quote.status}`);
    }
  }
  console.log(`${carriers.length} quote(s) submitted`);

  const listed = await getJson<QuoteResponse[]>(`/loads/${load.id}/quotes`);
  console.log(`GET /loads/${load.id}/quotes -> ${listed.body.length} quote(s), all "submitted"`);

  section(`3. ${CARRIER_COUNT} carriers accept the SAME load at the same time (POST /loads/:id/accept)`);
  const started = Date.now();
  const results = await Promise.allSettled(
    carriers.map((carrierId) =>
      postJson<AcceptLoadResponse | ApiError>(`/loads/${load.id}/accept`, {
        carrierId,
        idempotencyKey: `demo-${carrierId}`,
      }),
    ),
  );
  const elapsed = Date.now() - started;

  const fulfilled = results.map((r) => {
    if (r.status === "rejected") {
      throw new Error(`accept request failed at the network level: ${String(r.reason)}`);
    }
    return r.value;
  });
  const winners = fulfilled.filter((r) => r.status === 200);
  const losers = fulfilled.filter((r) => r.status !== 200);
  const codes = new Map<number, number>();
  for (const l of losers) {
    codes.set(l.status, (codes.get(l.status) ?? 0) + 1);
  }

  console.log(`fired    ${CARRIER_COUNT} in ${elapsed}ms`);
  console.log(`won      ${winners.length}`);
  console.log(`lost     ${losers.length}`);
  for (const [httpStatus, count] of codes) {
    console.log(`  ${count} x HTTP ${httpStatus}`);
  }

  let winningCarrierId: string | undefined;
  if (winners.length === 1) {
    const won = winners[0].body as AcceptLoadResponse;
    winningCarrierId = won.winningQuote.carrierId;
    console.log(`\nwinner   ${winningCarrierId}`);
    console.log(`status   ${won.winningQuote.status}`);
    console.log(`losers   ${won.losingQuotes} (reported by the gateway response itself)`);
  }

  section("4. The database agrees, reached only through the public API (GET /loads/:id)");
  const after = await getJson<LoadResponse>(`/loads/${load.id}`);
  console.log(`status   ${after.body.status}`);
  console.log(`carrier  ${after.body.carrierId ?? "(none)"}`);
  console.log(
    `matches winning quote: ${after.body.carrierId === winningCarrierId} `
      + "(ties the decision to the catalog, not just to whichever call happened to return first)",
  );

  section("5. The quotes end up won/lost/lost (GET /loads/:id/quotes)");
  const finalQuotes = await getJson<QuoteResponse[]>(`/loads/${load.id}/quotes`);
  const won = finalQuotes.body.filter((q) => q.status === "won");
  const lost = finalQuotes.body.filter((q) => q.status === "lost");
  console.log(`won   ${won.length}`);
  console.log(`lost  ${lost.length}`);

  console.log(
    "\nThe race is still decided by a conditional UPDATE inside the catalog service.\n"
      + "The gateway and bidding add HTTP and orchestration on top, but neither of\n"
      + "them resolves the dispute themselves: they ask the catalog to reserve the\n"
      + "load, and only one of those calls can ever succeed.\n",
  );
}

function i(carrierId: string): number {
  const match = /-(\d+)$/.exec(carrierId);
  return match ? Number(match[1]) : 0;
}

main().catch((err) => {
  console.error(
    `\nfailed: ${err instanceof Error ? err.message : String(err)}\n\n`
      + `Is the full stack up at ${BASE_URL}?\n`
      + "  docker compose up -d\n"
      + "  pnpm --filter catalog build && pnpm --filter bidding build && pnpm --filter gateway build\n"
      + "  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane "
      + "CATALOG_GRPC_URL=127.0.0.1:50051 node services/catalog/dist/main.js\n"
      + "  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane "
      + "CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 node services/bidding/dist/main.js\n"
      + "  CATALOG_GRPC_URL=127.0.0.1:50051 BIDDING_GRPC_URL=127.0.0.1:50052 "
      + "GATEWAY_HTTP_PORT=3000 node services/gateway/dist/main.js\n",
  );
  process.exit(1);
});
