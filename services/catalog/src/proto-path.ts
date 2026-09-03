import * as fs from "node:fs";
import * as path from "node:path";

// Unica fonte de verdade para a localizacao do catalog.proto: main.ts e o
// helper de teste (test/helpers/grpc.ts) importam esta constante em vez de
// recalcular o caminho cada um por conta propria.
//
// Resolucao por busca ascendente, em vez de contar niveis de diretorio: este
// mesmo arquivo roda a partir de dois lugares com profundidades diferentes em
// relacao a raiz do monorepo. Sob ts-jest/ts-node, __dirname aponta para
// services/catalog/src (fonte). Sob o build compilado, __dirname aponta para
// services/catalog/dist (veja tsconfig.build.json: rootDir "src" vira "dist"
// direto, sem o "dist/src" que "rootDir: '.'" produzia). Contar "3 niveis
// acima" funcionava para o primeiro caso e quebrava em producao: o dist
// buscava cargolane/services/proto, que nao existe. Os dois pontos de
// partida ficam exatamente um nivel dentro de services/catalog, entao subir a
// arvore a partir de __dirname ate achar um "proto/catalog.proto" funciona
// para ambos sem depender de qual dos dois esta rodando.
function findCatalogProto(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "proto", "catalog.proto");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `catalog.proto not found: walked up from "${startDir}" to the ` +
          "filesystem root without finding a proto/catalog.proto directory",
      );
    }
    dir = parent;
  }
}

export const CATALOG_PROTO_PATH = findCatalogProto(__dirname);
