import { DataSource, QueryFailedError } from "typeorm";
import { DuplicateQuoteError } from "./quote.errors";
import { QUOTE_LOAD_CARRIER_UNIQUE_CONSTRAINT, Quote, QuoteStatus } from "./quote.entity";

export interface SubmitQuoteInput {
  loadId: string;
  carrierId: string;
  priceCents: number;
  etaHours: number;
}

// Codigo do Postgres para violacao de constraint unique/primary key. Sozinho
// nao basta: identifica a familia do erro ("alguma" unique foi violada), nao
// qual. A tabela `quotes` tem hoje uma unica constraint unique alem da PK,
// entao o codigo sozinho "acerta" por coincidencia — mas o dia em que existir
// uma segunda constraint unique nesta tabela (por exemplo, se idempotency_key
// vier a virar coluna persistida em vez de so parametro de AcceptLoad),
// checar so o codigo reportaria a violacao dela como DuplicateQuoteError:
// uma mentira para o cliente.
const UNIQUE_VIOLATION = "23505";

interface PgUniqueViolationError {
  code?: string;
  // Nome da constraint violada. O driver `pg` preenche este campo no erro
  // que devolve, e QueryFailedError do TypeORM copia todas as propriedades
  // do driverError (inclusive esta) para si mesmo — o mesmo mecanismo pelo
  // qual `code` chega ate aqui.
  constraint?: string;
}

export class QuoteRepository {
  constructor(private readonly ds: DataSource) {}

  // A duplicidade e detectada pelo banco, nao por uma consulta previa: uma
  // leitura antes do INSERT abriria uma janela de corrida entre duas
  // transacoes concorrentes da mesma transportadora (mesma logica do UPDATE
  // condicional de LoadRepository.reserve). A constraint
  // @Unique(["loadId", "carrierId"]) do Quote e quem decide a disputa; aqui
  // so traduzimos a violacao (codigo 23505 + nome da constraint) para o erro
  // de dominio.
  async submit(input: SubmitQuoteInput): Promise<Quote> {
    const repo = this.ds.getRepository(Quote);
    try {
      return await repo.save(repo.create(input));
    } catch (e) {
      if (this.isLoadCarrierUniqueViolation(e)) {
        throw new DuplicateQuoteError(input.loadId, input.carrierId);
      }
      throw e;
    }
  }

  // So confirma existencia de cotacao SUBMITTED da transportadora: uma
  // cotacao ja WON ou LOST (aceitacao repetida, corrida ja decidida) nao
  // conta como "tem cotacao para aceitar".
  async findSubmittedQuote(loadId: string, carrierId: string): Promise<Quote | null> {
    return this.ds.getRepository(Quote).findOneBy({
      loadId, carrierId, status: QuoteStatus.SUBMITTED,
    });
  }

  // Sem filtro de status: usado por QuoteService.accept so depois que
  // findSubmittedQuote nao encontrou nada, para distinguir "esta
  // transportadora nunca cotou esta carga" (NoQuoteError) de "ela cotou, mas
  // a cotacao ja foi decidida — won ou lost" (QuoteAlreadyDecidedError). A
  // constraint @Unique(["loadId", "carrierId"]) garante no maximo uma linha.
  async findByLoadAndCarrier(loadId: string, carrierId: string): Promise<Quote | null> {
    return this.ds.getRepository(Quote).findOneBy({ loadId, carrierId });
  }

  // Isolado num metodo proprio (em vez de inline em QuoteService.accept)
  // porque uma versao futura troca esta chamada direta por um handler do
  // evento LoadReserved (quando o catalog passar a publicar esse evento): a
  // regra de "quem ganhou vira won, o resto vira lost" nao pode ficar
  // espalhada entre o orquestrador de hoje e o handler de evento de amanha.
  // So chamado depois que o catalog decidiu a disputa (nunca
  // antes) — este metodo em si nao decide nada, so registra uma decisao ja
  // tomada.
  //
  // As duas atualizacoes rodam na mesma transacao: sem isso, uma falha entre
  // marcar o vencedor e marcar os perdedores deixaria a carga com o vencedor
  // won mas os perdedores ainda submitted, um estado que nenhum caminho do
  // dominio deveria produzir.
  async markLosers(loadId: string, winnerCarrierId: string): Promise<number> {
    return this.ds.transaction(async (manager) => {
      await manager.getRepository(Quote).update(
        { loadId, carrierId: winnerCarrierId, status: QuoteStatus.SUBMITTED },
        { status: QuoteStatus.WON },
      );
      const result = await manager
        .createQueryBuilder()
        .update(Quote)
        .set({ status: QuoteStatus.LOST })
        .where(
          "load_id = :loadId AND carrier_id != :winnerCarrierId AND status = :submitted",
          { loadId, winnerCarrierId, submitted: QuoteStatus.SUBMITTED },
        )
        .execute();
      return result.affected ?? 0;
    });
  }

  async listByLoad(loadId: string): Promise<Quote[]> {
    return this.ds.createQueryBuilder(Quote, "q")
      .where("q.load_id = :loadId", { loadId })
      .orderBy("q.price_cents", "ASC")
      // Desempate deterministico: o Postgres nao garante ordem estavel entre
      // linhas de mesmo price_cents. created_at desempata pela ordem de
      // chegada; id (uuid) e o desempate final, para o caso (raro, mas
      // possivel em teste) de duas cotacoes com o mesmo created_at.
      .addOrderBy("q.created_at", "ASC")
      .addOrderBy("q.id", "ASC")
      .getMany();
  }

  // So classifica como duplicata quando o codigo 23505 (familia "violacao de
  // unicidade") E o nome da constraint batem com a que protege
  // (loadId, carrierId). Se `constraint` vier undefined por qualquer motivo
  // (driver diferente, versao futura do pg), preferimos propagar o erro
  // original a assumir duplicidade: errar reportando falha interna e melhor
  // do que errar mentindo a causa para o cliente.
  private isLoadCarrierUniqueViolation(e: unknown): boolean {
    if (!(e instanceof QueryFailedError)) {
      return false;
    }
    const driverError = e as unknown as PgUniqueViolationError;
    return driverError.code === UNIQUE_VIOLATION
      && driverError.constraint === QUOTE_LOAD_CARRIER_UNIQUE_CONSTRAINT;
  }
}
