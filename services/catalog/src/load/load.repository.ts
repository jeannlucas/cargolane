import { DataSource } from "typeorm";
import { Load, LoadStatus } from "./load.entity";
import { LoadNotOpenError } from "./load.errors";

export class LoadRepository {
  constructor(private readonly ds: DataSource) {}

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

    if (result.affected === 0) {
      throw new LoadNotOpenError(loadId);
    }
    // Releitura em vez de `.returning("*")`: o returning entrega as colunas
    // cruas do banco (`carrier_id`), nao a entidade mapeada (`carrierId`), e
    // devolver isso vazaria nomes de coluna para o controller. A releitura e
    // segura porque a carga ja saiu de `open` e ninguem mais a reserva.
    return this.ds.getRepository(Load).findOneByOrFail({ id: loadId });
  }
}
