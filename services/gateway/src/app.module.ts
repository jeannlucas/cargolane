import { Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { BIDDING_CLIENT } from "./bidding.constants";
import { CATALOG_CLIENT } from "./catalog.constants";
import { LoadsController } from "./loads/loads.controller";
import { BIDDING_PROTO_PATH, CATALOG_PROTO_PATH } from "./proto-path";
import { QuotesController } from "./quotes/quotes.controller";

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
            // defaults: true preenche campos repeated ausentes com [] em vez
            // de undefined. Em proto3, uma resposta sem nenhum item no
            // repeated chega sem o campo; sem esta opcao os controllers que
            // fazem `.map` sobre a lista (loads.controller, quotes.controller)
            // recebem undefined e lancam TypeError, virando 500. O mesmo
            // loader do lado do servidor (main.ts) nao sente diferenca porque
            // quem serializa a resposta e o proprio Nest, nao o loader.
            loader: { keepCase: true, defaults: true },
          },
        }),
      },
      {
        name: BIDDING_CLIENT,
        // Mesmo raciocinio de useFactory vs. register do CATALOG_CLIENT
        // acima: BIDDING_GRPC_URL precisa ser lida so no bootstrap, nunca no
        // import deste modulo, para o teste e2e (test/quotes.e2e.spec.ts)
        // poder apontar para um bidding de teste antes de criar a app.
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: "bidding",
            protoPath: BIDDING_PROTO_PATH,
            // BIDDING_GRPC_URL: mesma variavel que o bidding usa para saber
            // onde escutar (services/bidding/src/main.ts) — aqui o gateway a
            // le pelo mesmo motivo que le CATALOG_GRPC_URL.
            url: process.env.BIDDING_GRPC_URL ?? "localhost:50052",
            // Mesmo motivo do loader do CATALOG_CLIENT acima: sem
            // defaults: true, um repeated vazio na resposta (ex.: nenhuma
            // cotacao para a carga) chega como undefined em vez de [].
            loader: { keepCase: true, defaults: true },
          },
        }),
      },
    ]),
  ],
  controllers: [LoadsController, QuotesController],
})
export class AppModule {}
