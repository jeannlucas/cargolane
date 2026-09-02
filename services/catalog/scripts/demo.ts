// Interactive walkthrough of the catalog service against a running gRPC server.
//
// It exists because gRPC cannot be exercised with curl or a browser: without a
// client that speaks the protocol, the only way to drive the API would be the
// test suite. This script gives anyone who clones the repository a way to WATCH
// the race happen, which is the central mechanism of the project.
//
// It does not replace the tests: nothing here asserts anything, and the output
// is for humans to read. Run `pnpm --filter catalog test` for the guarantees.
//
// Uso:
//   1. docker compose up -d
//   2. pnpm --filter catalog build
//   3. DATABASE_URL=... node services/catalog/dist/main.js
//   4. pnpm --filter catalog demo        (in another terminal)
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { CATALOG_PROTO_PATH } from "../src/proto-path";

const ADDRESS = process.env.CATALOG_GRPC_URL ?? "localhost:50051";
const CARRIERS = Number(process.env.DEMO_CARRIERS ?? 50);

interface LoadMessage {
  id: string;
  shipper_id: string;
  origin: string;
  destination: string;
  weight_kg: number;
  pickup_window_end: string;
  price_ceiling_cents: number;
  status: string;
  carrier_id: string;
}

type Call<Req, Res> = (req: Req) => Promise<Res>;

interface Catalog {
  publishLoad: Call<Record<string, unknown>, LoadMessage>;
  getLoad: Call<{ id: string }, LoadMessage>;
  listLoads: Call<
    { origin?: string; destination?: string; limit?: number },
    { loads: LoadMessage[] }
  >;
  reserveLoad: Call<
    { load_id: string; carrier_id: string; idempotency_key: string },
    LoadMessage
  >;
}

// keepCase keeps the snake_case names from the .proto instead of camelizing, so
// the payload in code matches the contract exactly. The server uses the same
// option; diverging here would silently produce empty fields.
function connect(): { catalog: Catalog; close: () => void } {
  const pkg = grpc.loadPackageDefinition(
    protoLoader.loadSync(CATALOG_PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    }),
  ) as unknown as {
    catalog: {
      CatalogService: new (
        address: string,
        credentials: grpc.ChannelCredentials,
      ) => grpc.Client & Record<string, (...args: unknown[]) => unknown>;
    };
  };

  const raw = new pkg.catalog.CatalogService(
    ADDRESS,
    grpc.credentials.createInsecure(),
  );

  const promisify =
    <Req, Res>(method: string): Call<Req, Res> =>
    (req: Req) =>
      new Promise<Res>((resolve, reject) => {
        raw[method](req, (err: grpc.ServiceError | null, res: Res) =>
          err ? reject(err) : resolve(res),
        );
      });

  return {
    catalog: {
      publishLoad: promisify("PublishLoad"),
      getLoad: promisify("GetLoad"),
      listLoads: promisify("ListLoads"),
      reserveLoad: promisify("ReserveLoad"),
    },
    close: () => raw.close(),
  };
}

function section(title: string): void {
  console.log(`\n${"-".repeat(64)}\n${title}\n${"-".repeat(64)}`);
}

function codeName(err: unknown): string {
  const code = (err as grpc.ServiceError | undefined)?.code;
  return code === undefined ? "no code" : `${grpc.status[code]} (${code})`;
}

async function main(): Promise<void> {
  const { catalog, close } = connect();
  console.log(`cargolane demo — connecting to ${ADDRESS}`);

  const route = { origin: "Maringa/PR", destination: "Curitiba/PR" };

  section("1. Publish a load");
  const load = await catalog.publishLoad({
    shipper_id: "shipper-demo",
    ...route,
    weight_kg: 12000,
    pickup_window_end: new Date(Date.now() + 86_400_000).toISOString(),
    price_ceiling_cents: 350_000,
  });
  console.log(`id       ${load.id}`);
  console.log(`route    ${load.origin} -> ${load.destination}`);
  console.log(`status   ${load.status}`);
  console.log(`carrier  ${load.carrier_id === "" ? "(none)" : load.carrier_id}`);

  section("2. The load shows up among the open ones on that route");
  const before = await catalog.listLoads({ ...route, limit: 100 });
  console.log(`${before.loads.length} open load(s) on this route`);
  console.log(`ours is listed: ${before.loads.some((l) => l.id === load.id)}`);

  section(`3. ${CARRIERS} carriers accept the SAME load at the same time`);
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CARRIERS }, (_, i) =>
      catalog.reserveLoad({
        load_id: load.id,
        carrier_id: `carrier-${i}`,
        idempotency_key: `demo-${i}`,
      }),
    ),
  );
  const elapsed = Date.now() - started;

  const winners = results.filter((r) => r.status === "fulfilled");
  const losers = results.filter((r) => r.status === "rejected");
  const codes = new Map<string, number>();
  for (const l of losers) {
    const name = codeName((l as PromiseRejectedResult).reason);
    codes.set(name, (codes.get(name) ?? 0) + 1);
  }

  console.log(`fired    ${CARRIERS} in ${elapsed}ms`);
  console.log(`won      ${winners.length}`);
  console.log(`lost     ${losers.length}`);
  for (const [name, count] of codes) {
    console.log(`  ${count} x ${name}`);
  }
  if (winners.length === 1) {
    const won = (winners[0] as PromiseFulfilledResult<LoadMessage>).value;
    console.log(`\nwinner   ${won.carrier_id}`);
    console.log(`status   ${won.status}`);
  }

  section("4. The database agrees: one carrier, one state");
  const after = await catalog.getLoad({ id: load.id });
  console.log(`status   ${after.status}`);
  console.log(`carrier  ${after.carrier_id}`);

  section("5. The load leaves the open listing");
  const remaining = await catalog.listLoads({ ...route, limit: 100 });
  console.log(`still listed: ${remaining.loads.some((l) => l.id === load.id)}`);

  section("6. Distinct errors for distinct causes");
  try {
    await catalog.reserveLoad({
      load_id: load.id,
      carrier_id: "carrier-atrasada",
      idempotency_key: "demo-late",
    });
    console.log("already reserved: accepted (UNEXPECTED)");
  } catch (err) {
    console.log(`already reserved   ${codeName(err)}`);
  }
  try {
    await catalog.reserveLoad({
      load_id: "00000000-0000-4000-8000-000000000000",
      carrier_id: "carrier-fantasma",
      idempotency_key: "demo-ghost",
    });
    console.log("nonexistent load: accepted (UNEXPECTED)");
  } catch (err) {
    console.log(`nonexistent load   ${codeName(err)}`);
  }

  console.log(
    "\nThe race is decided by a conditional UPDATE in a local transaction.\n" +
      "No distributed lock, no Redis: Postgres itself serializes access to the\n" +
      "row, and whoever arrives later re-evaluates the predicate and loses.\n",
  );
  close();
}

main().catch((err) => {
  console.error(
    `\nfailed: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `Is the server up at ${ADDRESS}?\n` +
      "  docker compose up -d\n" +
      "  pnpm --filter catalog build\n" +
      "  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \\\n" +
      "    node services/catalog/dist/main.js\n",
  );
  process.exit(1);
});
