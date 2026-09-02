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

export class LoadRepository {
  constructor(private readonly ds: DataSource) {}

  async create(input: CreateLoadInput): Promise<Load> {
    const repo = this.ds.getRepository(Load);
    return repo.save(repo.create(input));
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
