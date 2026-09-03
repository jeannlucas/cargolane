import "reflect-metadata";
import * as net from "node:net";
import { AppModule as BiddingAppModule } from "bidding/src/app.module";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { BIDDING_PROTO_PATH } from "../../src/proto-path";
import { startCatalogForGatewayTests, TestCatalogServer } from "./catalog";
import { startPostgres } from "./pg";

// Sobe catalog e bidding de verdade (nenhum mock), cada um com seu proprio
// Postgres em porta efemera, para os testes e2e do gateway
// (test/quotes.e2e.spec.ts) exercitarem o fluxo completo de cotacao e
// aceitacao: SubmitQuote/ListQuotes so tocam o bidding, mas AcceptLoad
// orquestra os dois (bidding chama ReserveLoad no catalog para decidir a
// disputa — ver services/bidding/src/quote/quote.service.ts). Um catalog
// mockado nao reproduziria os codigos de erro reais (NOT_FOUND,
// FAILED_PRECONDITION) que a rota /loads/:id/accept precisa traduzir.
//
// "bidding" e devDependency do gateway via workspace:* (mesmo mecanismo que
// "catalog" ja usa aqui — ver test/helpers/catalog.ts). So usado em teste: o
// app.module.ts de producao do gateway resolve o proto do bidding por conta
// propria e nao importa nada deste pacote.

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

export interface TestCatalogAndBidding {
  // URLs no mesmo formato que o gateway (producao) espera em
  // CATALOG_GRPC_URL/BIDDING_GRPC_URL para saber onde discar.
  catalogUrl: string;
  biddingUrl: string;
  stop(): Promise<void>;
}

export async function startCatalogAndBiddingForGatewayTests(): Promise<TestCatalogAndBidding> {
  const catalog: TestCatalogServer = await startCatalogForGatewayTests();

  const biddingPg = await startPostgres();
  const biddingPort = await getEphemeralPort();
  const biddingUrl = `127.0.0.1:${biddingPort}`;

  // DATABASE_URL, CATALOG_GRPC_URL e BIDDING_GRPC_URL sao lidas de forma
  // sincrona pelo AppModule do bidding no momento em que createMicroservice o
  // instancia (useFactory de DataSource/CatalogClient, aguardado antes deste
  // await retornar); seguro reusar os mesmos nomes que o gateway usa para si
  // mesmo pelo mesmo motivo documentado em test/helpers/catalog.ts: os boots
  // (catalog acima, bidding aqui) rodam sequencialmente, nunca em paralelo,
  // dentro do mesmo processo Node. CATALOG_GRPC_URL ja aponta para o catalog
  // de teste recem-criado (startCatalogForGatewayTests deixa-a assim), entao
  // o CatalogClient do bidding disca para o catalog certo sem que este helper
  // precise repeti-la.
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousBiddingUrl = process.env.BIDDING_GRPC_URL;
  process.env.DATABASE_URL = biddingPg.url;
  process.env.BIDDING_GRPC_URL = biddingUrl;

  const biddingApp = await NestFactory.createMicroservice<MicroserviceOptions>(
    BiddingAppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: "bidding",
        protoPath: BIDDING_PROTO_PATH,
        url: biddingUrl,
        loader: { keepCase: true },
      },
    },
  );
  await biddingApp.listen();

  return {
    catalogUrl: catalog.url,
    biddingUrl,
    stop: async () => {
      await biddingApp.close();
      await biddingPg.stop();
      await catalog.stop();
      // Restaura os valores anteriores (mesmo que sejam undefined): quem
      // chamar este helper de novo depois deste stop() nao pode herdar as
      // variaveis do catalog/bidding de teste.
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousBiddingUrl === undefined) {
        delete process.env.BIDDING_GRPC_URL;
      } else {
        process.env.BIDDING_GRPC_URL = previousBiddingUrl;
      }
    },
  };
}
