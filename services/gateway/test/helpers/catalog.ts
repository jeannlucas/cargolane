import "reflect-metadata";
import * as net from "node:net";
import { AppModule as CatalogAppModule } from "catalog/src/app.module";
import { CATALOG_PROTO_PATH } from "catalog/src/proto-path";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { startPostgres } from "./pg";

// Sobe o microsservico catalog de verdade (nao um mock) contra um Postgres
// proprio, em porta efemera, para os testes e2e do gateway
// (test/loads.e2e.spec.ts) exercitarem a traducao REST-para-gRPC contra um
// catalog real: nenhum mock reproduz os codigos de erro reais que o catalog
// devolve (NOT_FOUND, INVALID_ARGUMENT) nem o schema/coluna `uuid` que faz um
// id malformado estourar um erro cru de driver — exatamente o caso que
// GET /loads/:id precisa distinguir de "carga inexistente".
//
// "catalog" e devDependency do gateway via workspace:* (pnpm symlinka
// services/catalog para node_modules/catalog, resolvendo para fora de
// node_modules — por isso ts-jest transforma o .ts normalmente, sem precisar
// de moduleNameMapper). So usado aqui, em teste: o app.module.ts de producao
// do gateway resolve o proto por conta propria e nao importa nada deste
// pacote.

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

export interface TestCatalogServer {
  // URL do catalog em teste: e o mesmo valor que o gateway (producao) espera
  // em CATALOG_GRPC_URL para saber onde discar.
  url: string;
  stop(): Promise<void>;
}

export async function startCatalogForGatewayTests(): Promise<TestCatalogServer> {
  const pg = await startPostgres();
  const port = await getEphemeralPort();
  const url = `127.0.0.1:${port}`;

  // DATABASE_URL e CATALOG_GRPC_URL sao lidos de forma sincrona pelo
  // AppModule do catalog no momento em que createMicroservice o instancia
  // (useFactory de DataSource, chamado e aguardado antes deste await
  // retornar); seguro reusar os mesmos nomes de variavel que o gateway usa
  // para si mesmo, porque os dois processos de boot (catalog aqui, gateway
  // no setup do proprio spec) rodam sequencialmente, nunca em paralelo,
  // dentro do mesmo processo Node.
  const previousDatabaseUrl = process.env.DATABASE_URL;
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

  return {
    url,
    stop: async () => {
      await app.close();
      await pg.stop();
      // Restaura o valor anterior (mesmo que seja undefined): quem chamar
      // startPostgres/startCatalogForGatewayTests depois deste stop() nao
      // pode herdar o DATABASE_URL do catalog.
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    },
  };
}
