import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { CATALOG_PROTO_PATH } from "../proto-path";

export interface ReserveLoadInput {
  loadId: string;
  carrierId: string;
  idempotencyKey: string;
}

// Marca explicita de origem: "este erro veio do catalog", nao "este erro
// tem a mesma forma de um erro do catalog". O controller classifica por
// `instanceof CatalogRpcError`, nunca por presenca estrutural de um campo
// `code` numerico — um erro futuro qualquer com `.code` numerico (nao
// necessariamente do catalog) nao pode vazar como status gRPC arbitrario
// para o cliente do bidding so por acidente de forma.
export class CatalogRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "CatalogRpcError";
  }
}

// Formato cru do Load devolvido pelo catalog (snake_case, igual ao .proto).
// Aqui so os campos que o bidding efetivamente usa (status e carrier_id) tem
// tipagem util a chamador; os demais existem so para nao quebrar o shape.
export interface CatalogLoad {
  id: string;
  status: string;
  carrier_id: string;
}

interface GrpcClientConstructor {
  new (address: string, credentials: grpc.ChannelCredentials): grpc.Client &
    Record<string, (...args: unknown[]) => unknown>;
}

// Cliente gRPC fino para o catalog: so conhece o proto e o endereco. O
// `code`/`message` do catalog atravessam intactos, embrulhados em
// CatalogRpcError so para marcar a origem — quem decide o que fazer com
// FAILED_PRECONDITION/NOT_FOUND e QuoteService, nao este cliente. Mudar o
// `code` ou a `message` aqui (em vez de so trocar o tipo do erro) apagaria a
// distincao entre "carga nao existe" e "carga ja foi de outro carrier", que
// e exatamente o que quem perdeu a corrida precisa saber.
export class CatalogClient {
  private readonly raw: grpc.Client & Record<string, (...args: unknown[]) => unknown>;

  constructor(address: string) {
    const packageDefinition = protoLoader.loadSync(CATALOG_PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      catalog: { CatalogService: GrpcClientConstructor };
    };
    this.raw = new proto.catalog.CatalogService(
      address,
      grpc.credentials.createInsecure(),
    );
  }

  reserveLoad(input: ReserveLoadInput): Promise<CatalogLoad> {
    return new Promise((resolve, reject) => {
      this.raw.ReserveLoad(
        {
          load_id: input.loadId,
          carrier_id: input.carrierId,
          idempotency_key: input.idempotencyKey,
        },
        (error: grpc.ServiceError | null, response: CatalogLoad) => {
          if (error) {
            // Rejeita com CatalogRpcError, nao com o grpc.ServiceError cru:
            // o `code` e a `message` atravessam intactos (nada e mascarado),
            // mas o tipo do erro passa a carregar a origem de forma
            // explicita, para quem trata a rejeicao mais adiante (o
            // controller) nao precisar adivinhar por forma.
            reject(new CatalogRpcError(error.code, error.details || error.message));
            return;
          }
          resolve(response);
        },
      );
    });
  }

  close(): void {
    this.raw.close();
  }
}
