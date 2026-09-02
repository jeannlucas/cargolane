import * as fs from "node:fs";
import * as path from "node:path";

// Unica fonte de verdade para a localizacao do bidding.proto: main.ts e o
// helper de teste (test/helpers/grpc.ts) importam esta constante em vez de
// recalcular o caminho cada um por conta propria.
//
// Resolucao por busca ascendente, em vez de contar niveis de diretorio: este
// mesmo arquivo roda a partir de dois lugares com profundidades diferentes em
// relacao a raiz do monorepo. Sob ts-jest/ts-node, __dirname aponta para
// services/bidding/src (fonte). Sob o build compilado, __dirname aponta para
// services/bidding/dist (veja tsconfig.build.json: rootDir "src" vira "dist"
// direto, sem o "dist/src" que "rootDir: '.'" produzia). Contar "3 niveis
// acima" funcionava para o primeiro caso e quebrava em producao (achado C-1
// do catalog: o dist buscava cargolane/services/proto, que nao existe). Os
// dois pontos de partida ficam exatamente um nivel dentro de services/bidding,
// entao subir a arvore a partir de __dirname ate achar um "proto/bidding.proto"
// funciona para ambos sem depender de qual dos dois esta rodando.
function findProto(fileName: string, startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, "proto", fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `${fileName} not found: walked up from "${startDir}" to the ` +
          `filesystem root without finding a proto/${fileName} directory`,
      );
    }
    dir = parent;
  }
}

export const BIDDING_PROTO_PATH = findProto("bidding.proto", __dirname);

// catalog.proto mora no mesmo diretorio "proto" na raiz do monorepo (veja
// findProto acima), entao a mesma busca ascendente encontra os dois arquivos
// a partir de __dirname do bidding. Resolvido aqui, e nao importado do
// pacote catalog, porque "catalog" e devDependency do bidding (so para
// subir o catalog de verdade em teste): o cliente gRPC de producao
// (catalog.client.ts) nao pode depender de um pacote que nao existe no
// deploy do bidding.
export const CATALOG_PROTO_PATH = findProto("catalog.proto", __dirname);
