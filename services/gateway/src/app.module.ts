import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { CATALOG_CLIENT } from "./catalog.constants";
import { LoadsController } from "./loads/loads.controller";
import { CATALOG_PROTO_PATH } from "./proto-path";

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CATALOG_CLIENT,
        // useFactory (registerAsync), nao um options object estatico
        // (register): o Nest so chama esta funcao quando resolve o provider
        // no bootstrap da app, nunca no momento em que este arquivo e
        // importado. Isso importa para os testes (test/loads.e2e.spec.ts):
        // eles definem CATALOG_GRPC_URL apontando para o catalog de teste
        // antes de criar a app, e um `register` estatico capturaria a
        // variavel de ambiente cedo demais, no import do modulo — o mesmo
        // motivo pelo qual o catalog e o bidding sempre leem process.env
        // dentro de um useFactory, nunca no corpo de um @Module.
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: "catalog",
            protoPath: CATALOG_PROTO_PATH,
            // CATALOG_GRPC_URL: mesma variavel que o catalog usa para saber
            // onde escutar (services/catalog/src/main.ts) e que o bidding
            // usa para saber onde discar (services/bidding/src/quote/catalog.client.ts)
            // — aqui o gateway a le pelo mesmo motivo.
            url: process.env.CATALOG_GRPC_URL ?? "localhost:50051",
            loader: { keepCase: true },
          },
        }),
      },
    ]),
  ],
  controllers: [LoadsController],
})
export class AppModule {}
