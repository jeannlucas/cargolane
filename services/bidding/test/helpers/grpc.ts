import "reflect-metadata";
import * as net from "node:net";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { DataSource } from "typeorm";
import { AppModule } from "../../src/app.module";
import { BIDDING_PROTO_PATH } from "../../src/proto-path";
import { startPostgres } from "./pg";

// Porta 0 pede ao SO uma porta livre; lemos qual foi escolhida e fechamos o
// socket de sondagem antes do grpc-js abrir a dele nessa mesma porta. Ha uma
// janela teorica de corrida entre o close() e o bind do servidor grpc, mas e
// o mesmo custo-beneficio que o resto da suite aceita para portas efemeras em
// teste.
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

export interface QuoteMessage {
  id: string;
  load_id: string;
  carrier_id: string;
  price_cents: number;
  eta_hours: number;
  status: string;
}

export interface BiddingGrpcClient {
  submitQuote(req: {
    load_id: string;
    carrier_id: string;
    price_cents: number;
    eta_hours: number;
  }): Promise<QuoteMessage>;
  listQuotes(req: { load_id: string }): Promise<{ quotes: QuoteMessage[] }>;
}

export interface TestBiddingServer {
  client: BiddingGrpcClient;
  // Exposto para os testes verificarem estado direto no banco sem precisar
  // inventar um RPC so para isso.
  ds: DataSource;
  stop(): Promise<void>;
}

interface GrpcClientConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): grpc.Client &
    Record<string, (...args: unknown[]) => unknown>;
}

// Sobe a app Nest (gRPC) inteira, com Postgres real via Testcontainers, em
// uma porta efemera, e devolve um cliente gRPC com metodos promisificados.
export async function startBiddingGrpcServer(): Promise<TestBiddingServer> {
  const pg = await startPostgres();
  const port = await getEphemeralPort();
  const url = `127.0.0.1:${port}`;

  process.env.DATABASE_URL = pg.url;
  process.env.BIDDING_GRPC_URL = url;

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: "bidding",
        protoPath: BIDDING_PROTO_PATH,
        url,
        // keepCase preserva os nomes snake_case do .proto: sem isso o
        // proto-loader converte para camelCase e o cliente (que fala
        // snake_case, igual ao contrato) deixa de bater com o servidor.
        loader: { keepCase: true },
      },
    },
  );
  await app.listen();
  const ds = app.get(DataSource);

  const packageDefinition = protoLoader.loadSync(BIDDING_PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
    bidding: { BiddingService: GrpcClientConstructor };
  };
  const rawClient = new proto.bidding.BiddingService(
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

  const client: BiddingGrpcClient = {
    submitQuote: promisify("SubmitQuote"),
    listQuotes: promisify("ListQuotes"),
  };

  return {
    client,
    ds,
    stop: async () => {
      rawClient.close();
      await app.close();
      await pg.stop();
    },
  };
}
