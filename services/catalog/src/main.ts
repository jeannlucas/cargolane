import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MicroserviceOptions, Transport } from "@nestjs/microservices";
import { AppModule } from "./app.module";
import { CATALOG_PROTO_PATH } from "./proto-path";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.GRPC,
      options: {
        package: "catalog",
        protoPath: CATALOG_PROTO_PATH,
        url: process.env.CATALOG_GRPC_URL ?? "0.0.0.0:50051",
        loader: { keepCase: true },
      },
    },
  );
  app.enableShutdownHooks();
  await app.listen();
}

// Sem este .catch(), uma falha de boot (ex.: Postgres fora do ar, .proto
// ausente) vira uma promise rejeitada sem handler: o Node imprime a rejeicao
// com stack de node_modules e sai com codigo 1 de qualquer jeito, mas sem
// mensagem clara nem controle sobre o exit code. Aqui logamos com o Logger do
// Nest e encerramos explicitamente.
bootstrap().catch((error: unknown) => {
  new Logger("Bootstrap").error(
    "failed to start catalog service",
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
