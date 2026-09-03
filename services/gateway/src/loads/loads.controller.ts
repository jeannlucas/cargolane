import {
  Body, Controller, Get, HttpCode, HttpStatus, Inject, OnModuleInit, Param,
  ParseUUIDPipe, Post, Query,
} from "@nestjs/common";
import { ClientGrpc } from "@nestjs/microservices";
import { firstValueFrom, Observable } from "rxjs";
import { CATALOG_CLIENT } from "../catalog.constants";
import { CreateLoadDto, ListLoadsQueryDto } from "./loads.dto";

// Forma crua devolvida pelo catalog (snake_case, igual ao .proto). Nao
// reexportada: fica encapsulada aqui, o REST fala camelCase (toLoadResponse
// abaixo faz a traducao).
interface CatalogLoadMessage {
  id: string;
  shipper_id: string;
  origin: string;
  destination: string;
  weight_kg: number;
  pickup_window_end: string;
  price_ceiling_cents: number;
  status: string;
  carrier_id: string;
}

// Stub gerado pelo ClientGrpc.getService: os nomes dos metodos sao
// exatamente os nomes das rpc no .proto (PascalCase), nao camelCase — ver
// ClientGrpcProxy.getService em @nestjs/microservices, que copia os nomes
// do stub gerado pelo @grpc/grpc-js sem conversao de caixa.
interface CatalogGrpcService {
  PublishLoad(data: {
    shipper_id: string;
    origin: string;
    destination: string;
    weight_kg: number;
    pickup_window_end: string;
    price_ceiling_cents: number;
  }): Observable<CatalogLoadMessage>;
  GetLoad(data: { id: string }): Observable<CatalogLoadMessage>;
  ListLoads(data: {
    origin: string;
    destination: string;
    limit: number;
  }): Observable<{ loads: CatalogLoadMessage[] }>;
}

export interface LoadResponse {
  id: string;
  shipperId: string;
  origin: string;
  destination: string;
  weightKg: number;
  pickupWindowEnd: string;
  priceCeilingCents: number;
  status: string;
  carrierId: string | null;
}

// proto3 nao tem null: carrier_id ausente (ninguem reservou ainda) vira
// string vazia na mensagem gRPC. O REST devolve null nesse caso, mais
// idiomatico para um cliente HTTP do que uma string vazia com significado
// especial.
function toLoadResponse(load: CatalogLoadMessage): LoadResponse {
  return {
    id: load.id,
    shipperId: load.shipper_id,
    origin: load.origin,
    destination: load.destination,
    weightKg: load.weight_kg,
    pickupWindowEnd: load.pickup_window_end,
    priceCeilingCents: load.price_ceiling_cents,
    status: load.status,
    carrierId: load.carrier_id || null,
  };
}

@Controller("loads")
export class LoadsController implements OnModuleInit {
  private catalog!: CatalogGrpcService;

  constructor(@Inject(CATALOG_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.catalog = this.client.getService<CatalogGrpcService>("CatalogService");
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateLoadDto): Promise<LoadResponse> {
    const load = await firstValueFrom(
      this.catalog.PublishLoad({
        shipper_id: dto.shipperId,
        origin: dto.origin,
        destination: dto.destination,
        weight_kg: dto.weightKg,
        pickup_window_end: dto.pickupWindowEnd,
        price_ceiling_cents: dto.priceCeilingCents,
      }),
    );
    return toLoadResponse(load);
  }

  // ParseUUIDPipe corta um id malformado (ex.: "not-an-id") com 400 antes de
  // qualquer chamada ao catalog. Sem isso, um id malformado chegaria ao
  // `findOneBy({ id })` do catalog (services/catalog/src/load/load.repository.ts),
  // que dispara um erro cru do driver Postgres ("invalid input syntax for
  // type uuid") sem `instanceof` nenhum dos erros de dominio do catalog —
  // esse erro atravessa o controller gRPC do catalog sem virar
  // NOT_FOUND/INVALID_ARGUMENT, chega como UNKNOWN, e o filtro deste gateway
  // o classificaria como 500. Este e o achado do Marco 1 que esta rota
  // fecha: tres classes distintas de erro (id malformado, id bem formado mas
  // inexistente, e um erro de fato inesperado) nao podem colapsar todas em
  // "500 generico".
  @Get(":id")
  async getById(@Param("id", new ParseUUIDPipe()) id: string): Promise<LoadResponse> {
    const load = await firstValueFrom(this.catalog.GetLoad({ id }));
    return toLoadResponse(load);
  }

  @Get()
  async list(@Query() query: ListLoadsQueryDto): Promise<LoadResponse[]> {
    const { loads } = await firstValueFrom(
      this.catalog.ListLoads({
        origin: query.origin ?? "",
        destination: query.destination ?? "",
        limit: query.limit ?? 0,
      }),
    );
    return loads.map(toLoadResponse);
  }
}
