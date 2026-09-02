import * as path from "node:path";

// Unica fonte de verdade para a localizacao do catalog.proto: main.ts e o
// helper de teste (test/helpers/grpc.ts) importam esta constante em vez de
// recalcular o caminho cada um por conta propria. Assume execucao a partir do
// codigo-fonte (ts-node/ts-jest), onde __dirname aponta para
// services/catalog/src; 3 niveis acima chega na raiz do monorepo.
export const CATALOG_PROTO_PATH = path.resolve(
  __dirname,
  "../../../proto/catalog.proto",
);
