import "reflect-metadata";
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

bootstrap();
