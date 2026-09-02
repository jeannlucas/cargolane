import "reflect-metadata";
import * as net from "node:net";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { AppModule as CatalogAppModule } from "catalog/src/app.module";
import { CATALOG_PROTO_PATH } from "catalog/src/proto-path";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { DataSource } from "typeorm";
import { startPostgres } from "./pg";

// Sobe o microsservico catalog de verdade (nao um mock) contra um Postgres
// proprio, em porta efemera, para os testes de orquestracao do bidding
// (quote.accept.spec.ts) exercitarem a chamada gRPC real ao catalog: a
// disputa por uma carga e decidida por um UPDATE condicional dentro do
// catalog (ver services/catalog/src/load/load.repository.ts), e nenhum mock
// reproduz nem essa corrida nem os codigos de erro reais que ela devolve.
//
// "catalog" e devDependency do bidding via workspace:* (pnpm symlinka
// services/catalog para node_modules/catalog, resolvendo para fora de
// node_modules — por isso ts-jest transforma o .ts normalmente, sem precisar
// de moduleNameMapper). So usado aqui, em teste: o cliente gRPC de producao
// do bidding (src/quote/catalog.client.ts) resolve o proto por conta propria
// e nao importa nada deste pacote.

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("could not allocate an ephemeral port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export interface CatalogLoadMessage {
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

export interface CatalogTestGrpcClient {
  publishLoad(req: {
    shipper_id: string;
    origin: string;
    destination: string;
    weight_kg: number;
    pickup_window_end: string;
    price_ceiling_cents: number;
  }): Promise<CatalogLoadMessage>;
  getLoad(req: { id: string }): Promise<CatalogLoadMessage>;
  reserveLoad(req: {
    load_id: string;
    carrier_id: string;
    idempotency_key: string;
  }): Promise<CatalogLoadMessage>;
}

export interface TestCatalogServer {
  // URL do catalog em teste: e o mesmo valor que CatalogClient (producao)
  // espera em CATALOG_GRPC_URL para saber onde discar.
  url: string;
  // Cliente gRPC bruto, usado pelos testes para montar fixtures (publicar
  // carga) e para simular "carga reservada por outro caminho" (chamando
  // ReserveLoad diretamente, sem passar pelo bidding).
  client: CatalogTestGrpcClient;
  // Exposto para os testes confirmarem estado direto no banco do catalog
  // (ex.: carga continua "open" quando o bidding nao deveria te-lo chamado).
  ds: DataSource;
  stop(): Promise<void>;
}

interface GrpcClientConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): grpc.Client &
    Record<string, (...args: unknown[]) => unknown>;
}

export async function startCatalogForBiddingTests(): Promise<TestCatalogServer> {
  const pg = await startPostgres();
  const port = await getEphemeralPort();
  const url = `127.0.0.1:${port}`;

  // DATABASE_URL e CATALOG_GRPC_URL sao lidos de forma sincrona pelo
  // AppModule do catalog no momento em que createMicroservice o instancia
  // (useFactory de DataSource, chamado e aguardado antes deste await
  // retornar); seguro reusar os mesmos nomes de variavel que o bidding usa
  // para si mesmo, porque os dois processos de boot (catalog aqui, bidding
  // no teardown/setup do proprio spec) rodam sequencialmente, nunca em
  // paralelo, dentro do mesmo processo Node.
  process.env.DATABASE_URL = pg.url;
  process.env.CATALOG_GRPC_URL = url;

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    CatalogAppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: "catalog",
        protoPath: CATALOG_PROTO_PATH,
        url,
        loader: { keepCase: true },
      },
    },
  );
  await app.listen();
  const ds = app.get(DataSource);

  const packageDefinition = protoLoader.loadSync(CATALOG_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    catalog: { CatalogService: GrpcClientConstructor };
  };
  const rawClient = new proto.catalog.CatalogService(
    url,
    grpc.credentials.createInsecure(),
  );

  function promisify<Req, Res>(method: string) {
    return (req: Req) =>
      new Promise<Res>((resolve, reject) => {
        rawClient[method](
          req,
          (error: grpc.ServiceError | null, response: Res) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(response);
          },
        );
      });
  }

  const client: CatalogTestGrpcClient = {
    publishLoad: promisify("PublishLoad"),
    getLoad: promisify("GetLoad"),
    reserveLoad: promisify("ReserveLoad"),
  };

  return {
    url,
    client,
    ds,
    stop: async () => {
      rawClient.close();
      await app.close();
      await pg.stop();
    },
  };
}
