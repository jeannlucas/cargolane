import { Injectable } from "@nestjs/common";
import { InvalidLoadError } from "./load.errors";
import { Load } from "./load.entity";
import { CreateLoadInput, ListLoadsFilter, LoadRepository } from "./load.repository";

const DEFAULT_LIST_LIMIT = 20;
const MIN_LIST_LIMIT = 1;
const MAX_LIST_LIMIT = 100;

@Injectable()
export class LoadService {
  constructor(private readonly loads: LoadRepository) {}

  // Valida a invariante de dominio antes de tocar o banco: uma checagem
  // depois do INSERT nao protege nada, so classifica o dado invalido ja
  // persistido.
  async publish(input: CreateLoadInput): Promise<Load> {
    this.validate(input);
    return this.loads.create(input);
  }

  get(loadId: string): Promise<Load> {
    return this.loads.findById(loadId);
  }

  list(filter: ListLoadsFilter): Promise<Load[]> {
    return this.loads.list({ ...filter, limit: this.normalizeLimit(filter.limit) });
  }

  reserve(loadId: string, carrierId: string): Promise<Load> {
    return this.loads.reserve(loadId, carrierId);
  }

  // limit: 0 e o que o proto3 envia quando o cliente nao preenche o campo
  // int32 (default de proto3 e o zero-value). Cair no `|| DEFAULT_LIST_LIMIT`
  // e intencional: "sem limite informado" e "limite zero" sao indistinguiveis
  // no fio, entao tratamos os dois como "usar o default". Math.floor garante
  // inteiro: o TypeORM interpola o LIMIT direto no SQL (nao como parametro),
  // e o Postgres aceita `LIMIT 1.5` sem erro, arredondando em silencio. Isso
  // nao e alcancavel via gRPC (int32 nao carrega fracao no fio), mas
  // LoadService.list e assinatura publica chamavel por qualquer codigo
  // TypeScript. Normalizar o limite e regra de negocio (o que e um limite
  // razoavel de paginacao), nao acesso a dados: por isso mora aqui, nao no
  // repositorio.
  private normalizeLimit(limit: number): number {
    return Math.floor(
      Math.min(Math.max(limit || DEFAULT_LIST_LIMIT, MIN_LIST_LIMIT), MAX_LIST_LIMIT),
    );
  }

  private validate(input: CreateLoadInput): void {
    if (input.shipperId.trim() === "") {
      throw new InvalidLoadError("shipperId", "must not be blank");
    }
    if (input.weightKg <= 0) {
      throw new InvalidLoadError("weightKg", "must be greater than zero");
    }
    if (input.priceCeilingCents <= 0) {
      throw new InvalidLoadError("priceCeilingCents", "must be greater than zero");
    }
    if (input.pickupWindowEnd.getTime() <= Date.now()) {
      throw new InvalidLoadError("pickupWindowEnd", "must be in the future");
    }
    if (input.origin === input.destination) {
      throw new InvalidLoadError("destination", "must differ from origin");
    }
  }
}
