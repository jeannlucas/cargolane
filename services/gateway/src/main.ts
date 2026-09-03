import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { createApp } from "./create-app";

async function bootstrap(): Promise<void> {
  const app = await createApp();
  app.enableShutdownHooks();
  const port = Number(process.env.GATEWAY_HTTP_PORT ?? 3000);
  await app.listen(port);
}

// Sem este .catch(), uma falha de boot (ex.: catalog fora do ar na hora de
// carregar o proto) vira uma promise rejeitada sem handler: o Node imprime a
// rejeicao com stack de node_modules e sai com codigo 1 de qualquer jeito,
// mas sem mensagem clara nem controle sobre o exit code. Aqui logamos com o
// Logger do Nest e encerramos explicitamente.
bootstrap().catch((error: unknown) => {
  new Logger("Bootstrap").error(
    "failed to start gateway service",
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
