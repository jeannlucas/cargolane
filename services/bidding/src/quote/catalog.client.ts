import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { CATALOG_PROTO_PATH } from "../proto-path";

export interface ReserveLoadInput {
  loadId: string;
  carrierId: string;
  idempotencyKey: string;
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

// Cliente gRPC fino para o catalog: so conhece o proto e o endereco. Erros
// atravessam sem traducao (grpc.ServiceError, com .code ja no vocabulario de
// status gRPC do proprio catalog) — quem decide o que fazer com
// FAILED_PRECONDITION/NOT_FOUND e QuoteService, nao este cliente. Mascarar
// o erro aqui (embrulhando num tipo generico) apagaria a distincao entre
// "carga nao existe" e "carga ja foi de outro carrier", que e exatamente o
// que quem perdeu a corrida precisa saber.
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
            reject(error);
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
