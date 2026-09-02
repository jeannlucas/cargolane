// Demonstracao interativa do catalog contra um servidor gRPC ja em execucao.
//
// Existe porque gRPC nao se testa com curl nem com navegador: sem um cliente
// que fale o protocolo, a unica forma de exercitar a API seria a suite de
// testes. Este script da a qualquer pessoa que clone o repositorio uma maneira
// de VER a disputa acontecer, que e o mecanismo central do projeto.
//
// Nao substitui os testes: nada aqui e assercao, e a saida e para leitura
// humana. Rode `pnpm --filter catalog test` para as garantias.
//
// Uso:
//   1. docker compose up -d
//   2. pnpm --filter catalog build
//   3. DATABASE_URL=... node services/catalog/dist/main.js
//   4. pnpm --filter catalog demo        (noutro terminal)
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

// keepCase mantem os nomes snake_case do .proto em vez de camelizar, para que
// o payload no codigo seja identico ao do contrato. O servidor usa a mesma
// opcao; divergir aqui produziria campos silenciosamente vazios.
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
  return code === undefined ? "sem codigo" : `${grpc.status[code]} (${code})`;
}

async function main(): Promise<void> {
  const { catalog, close } = connect();
  console.log(`cargolane demo — conectando em ${ADDRESS}`);

  const route = { origin: "Maringa/PR", destination: "Curitiba/PR" };

  section("1. Publicar uma carga");
  const load = await catalog.publishLoad({
    shipper_id: "shipper-demo",
    ...route,
    weight_kg: 12000,
    pickup_window_end: new Date(Date.now() + 86_400_000).toISOString(),
    price_ceiling_cents: 350_000,
  });
  console.log(`id      ${load.id}`);
  console.log(`rota    ${load.origin} -> ${load.destination}`);
  console.log(`status  ${load.status}`);
  console.log(`carrier ${load.carrier_id === "" ? "(nenhum)" : load.carrier_id}`);

  section("2. A carga aparece entre as abertas da rota");
  const before = await catalog.listLoads({ ...route, limit: 100 });
  console.log(`${before.loads.length} carga(s) aberta(s) nesta rota`);
  console.log(`a nossa esta na lista: ${before.loads.some((l) => l.id === load.id)}`);

  section(`3. ${CARRIERS} transportadoras aceitam a MESMA carga ao mesmo tempo`);
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

  console.log(`disparadas   ${CARRIERS} em ${elapsed}ms`);
  console.log(`venceram     ${winners.length}`);
  console.log(`perderam     ${losers.length}`);
  for (const [name, count] of codes) {
    console.log(`  ${count} x ${name}`);
  }
  if (winners.length === 1) {
    const won = (winners[0] as PromiseFulfilledResult<LoadMessage>).value;
    console.log(`\nvencedora    ${won.carrier_id}`);
    console.log(`status       ${won.status}`);
  }

  section("4. O banco concorda: uma transportadora, um estado");
  const after = await catalog.getLoad({ id: load.id });
  console.log(`status  ${after.status}`);
  console.log(`carrier ${after.carrier_id}`);

  section("5. A carga sai da listagem de abertas");
  const remaining = await catalog.listLoads({ ...route, limit: 100 });
  console.log(`ainda na lista: ${remaining.loads.some((l) => l.id === load.id)}`);

  section("6. Erros distintos para causas distintas");
  try {
    await catalog.reserveLoad({
      load_id: load.id,
      carrier_id: "carrier-atrasada",
      idempotency_key: "demo-late",
    });
    console.log("carga ja reservada: aceitou (INESPERADO)");
  } catch (err) {
    console.log(`carga ja reservada   ${codeName(err)}`);
  }
  try {
    await catalog.reserveLoad({
      load_id: "00000000-0000-4000-8000-000000000000",
      carrier_id: "carrier-fantasma",
      idempotency_key: "demo-ghost",
    });
    console.log("carga inexistente: aceitou (INESPERADO)");
  } catch (err) {
    console.log(`carga inexistente    ${codeName(err)}`);
  }

  console.log(
    "\nA disputa e decidida por um UPDATE condicional em transacao local.\n" +
      "Sem lock distribuido, sem Redis: o proprio Postgres serializa o acesso\n" +
      "a linha, e quem chega depois reavalia o predicado e perde.\n",
  );
  close();
}

main().catch((err) => {
  console.error(
    `\nfalhou: ${err instanceof Error ? err.message : String(err)}\n\n` +
      `O servidor esta no ar em ${ADDRESS}?\n` +
      "  docker compose up -d\n" +
      "  pnpm --filter catalog build\n" +
      "  DATABASE_URL=postgres://cargolane:cargolane@localhost:5432/cargolane \\\n" +
      "    node services/catalog/dist/main.js\n",
  );
  process.exit(1);
});
