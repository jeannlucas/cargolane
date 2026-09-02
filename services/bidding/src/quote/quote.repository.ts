import { DataSource, QueryFailedError } from "typeorm";
import { DuplicateQuoteError } from "./quote.errors";
import { Quote } from "./quote.entity";

export interface SubmitQuoteInput {
  loadId: string;
  carrierId: string;
  priceCents: number;
  etaHours: number;
}

// Codigo do Postgres para violacao de constraint unique/primary key.
const UNIQUE_VIOLATION = "23505";

export class QuoteRepository {
  constructor(private readonly ds: DataSource) {}

  // A duplicidade e detectada pelo banco, nao por uma consulta previa: uma
  // leitura antes do INSERT abriria uma janela de corrida entre duas
  // transacoes concorrentes da mesma transportadora (mesma logica do UPDATE
  // condicional de LoadRepository.reserve). A constraint
  // @Unique(["loadId", "carrierId"]) do Quote e quem decide a disputa; aqui
  // so traduzimos a violacao (codigo 23505) para o erro de dominio.
  async submit(input: SubmitQuoteInput): Promise<Quote> {
    const repo = this.ds.getRepository(Quote);
    try {
      return await repo.save(repo.create(input));
    } catch (e) {
      if (e instanceof QueryFailedError && (e as unknown as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateQuoteError(input.loadId, input.carrierId);
      }
      throw e;
    }
  }

  async listByLoad(loadId: string): Promise<Quote[]> {
    return this.ds.createQueryBuilder(Quote, "q")
      .where("q.load_id = :loadId", { loadId })
      .orderBy("q.price_cents", "ASC")
      .getMany();
  }
}
