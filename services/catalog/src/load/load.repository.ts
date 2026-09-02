import { DataSource } from "typeorm";
import { Load, LoadStatus } from "./load.entity";
import { LoadNotFoundError, LoadNotOpenError } from "./load.errors";

export interface CreateLoadInput {
  shipperId: string;
  origin: string;
  destination: string;
  weightKg: number;
  pickupWindowEnd: Date;
  priceCeilingCents: number;
}

export interface ListLoadsFilter {
  origin?: string;
  destination?: string;
  limit: number;
}

export class LoadRepository {
  constructor(private readonly ds: DataSource) {}

  async create(input: CreateLoadInput): Promise<Load> {
    const repo = this.ds.getRepository(Load);
    return repo.save(repo.create(input));
  }

  // limit: 0 e o que o proto3 envia quando o cliente nao preenche o campo
  // int32 (default de proto3 e o zero-value). Cair no `|| 20` e intencional:
  // "sem limite informado" e "limite zero" sao indistinguiveis no fio, entao
  // tratamos os dois como "usar o default". Math.floor garante inteiro: o
  // TypeORM interpola o LIMIT direto no SQL (nao como parametro), e o
  // Postgres aceita `LIMIT 1.5` sem erro, arredondando em silencio. Isso nao
  // e alcancavel via gRPC (int32 nao carrega fracao no fio), mas `list` e
  // assinatura publica chamavel por qualquer codigo TypeScript.
  async list(f: ListLoadsFilter): Promise<Load[]> {
    const qb = this.ds.createQueryBuilder(Load, "l")
      .where("l.status = :open", { open: LoadStatus.OPEN })
      .orderBy("l.created_at", "DESC")
      .limit(Math.floor(Math.min(Math.max(f.limit || 20, 1), 100)));
    if (f.origin) {
      qb.andWhere("l.origin = :origin", { origin: f.origin });
    }
    if (f.destination) {
      qb.andWhere("l.destination = :destination", { destination: f.destination });
    }
    return qb.getMany();
  }

  async findById(loadId: string): Promise<Load> {
    const found = await this.ds.getRepository(Load).findOneBy({ id: loadId });
    if (!found) {
      throw new LoadNotFoundError(loadId);
    }
    return found;
  }

  // A disputa inteira e decidida por este UPDATE condicional. Uma transacao
  // afeta uma linha e ganha; as demais afetam zero. Sem lock distribuido:
  // o proprio banco serializa o acesso a linha.
  async reserve(loadId: string, carrierId: string): Promise<Load> {
    const result = await this.ds
      .createQueryBuilder()
      .update(Load)
      .set({ status: LoadStatus.RESERVED, carrierId })
      .where("id = :loadId AND status = :open", {
        loadId,
        open: LoadStatus.OPEN,
      })
      .execute();

    if (!result.affected) {
      // O UPDATE condicional acima nao distingue "loadId nao existe" de
      // "existe mas nao esta open": os dois casos afetam zero linhas. Esta
      // consulta extra so roda no caminho de falha (raro, comparado ao
      // caminho feliz de uma reserva bem-sucedida), entao nao custa nada em
      // termos de desempenho, e nao abre janela de corrida relevante: a
      // disputa ja foi decidida pelo UPDATE, aqui so classificamos por que
      // ele nao afetou nenhuma linha.
      const existing = await this.ds.getRepository(Load).findOneBy({ id: loadId });
      if (!existing) {
        throw new LoadNotFoundError(loadId);
      }
      throw new LoadNotOpenError(loadId);
    }
    // Releitura em vez de `.returning("*")`: o returning entrega as colunas
    // cruas do banco (`carrier_id`), nao a entidade mapeada (`carrierId`), e
    // devolver isso vazaria nomes de coluna para o controller. A garantia que
    // o UPDATE acima da e apenas esta: a linha saiu de `open` e nenhuma outra
    // chamada a reserve() pode ter vencido a mesma corrida. Ela nao impede que
    // outro caminho (cancel, expire) altere a linha entre o UPDATE e esta
    // releitura; quando esses caminhos existirem, o estado relido pode ja ter
    // avancado para `cancelled`/`expired`, e quem chamou reserve() precisa
    // estar ciente disso.
    const reserved = await this.ds.getRepository(Load).findOneBy({ id: loadId });
    if (!reserved) {
      throw new LoadNotFoundError(loadId);
    }
    return reserved;
  }
}
