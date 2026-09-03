import { INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { GrpcErrorFilter } from "./grpc-error.filter";

// Fabrica unica da app HTTP: main.ts (producao) e o teste e2e
// (test/loads.e2e.spec.ts) chamam esta mesma funcao, para main.ts nao
// duplicar a configuracao de ValidationPipe/filtro de erro com o teste.
// Duplicar essa configuracao no teste faria uma sabotagem em producao (ex.:
// remover o ValidationPipe de main.ts) nao derrubar o teste correspondente
// — o oposto do que a sabotagem existe para provar.
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    // whitelist + forbidNonWhitelisted: campo desconhecido no corpo e erro
    // 400, nao silencio (a propriedade e descartada por padrao sem
    // forbidNonWhitelisted, o que esconderia um erro de integracao do
    // cliente). transform: converte query string (sempre texto no fio) para
    // os tipos declarados no DTO antes da validacao — ver
    // ListLoadsQueryDto.limit em loads.dto.ts.
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new GrpcErrorFilter());
  return app;
}
