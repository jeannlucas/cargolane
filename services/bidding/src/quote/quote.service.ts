import { Injectable } from "@nestjs/common";
import { trackBiddingAcceptInFlight } from "./accept-in-flight-tracker";
import { CatalogClient } from "./catalog.client";
import { NoQuoteError, InvalidQuoteError, QuoteAlreadyDecidedError } from "./quote.errors";
import { Quote, QuoteStatus } from "./quote.entity";
import { QuoteRepository, SubmitQuoteInput } from "./quote.repository";

export interface AcceptLoadResult {
  winningQuote: Quote;
  losingQuotes: number;
}

@Injectable()
export class QuoteService {
  constructor(
    private readonly quotes: QuoteRepository,
    private readonly catalog: CatalogClient,
  ) {}

  // Valida a invariante de dominio antes de tocar o banco: uma checagem
  // depois do INSERT nao protege nada, so classifica o dado invalido ja
  // persistido.
  async submit(input: SubmitQuoteInput): Promise<Quote> {
    this.validate(input);
    return this.quotes.submit(input);
  }

  listByLoad(loadId: string): Promise<Quote[]> {
    return this.quotes.listByLoad(loadId);
  }

  // Ordem obrigatoria: (1) confirmar cotacao submitted da transportadora,
  // sem tocar o catalog quando ela nao existe — evita gastar uma chamada de
  // rede (e, pior, decidir uma disputa no catalog) para um pedido que ja
  // deveria falhar aqui; (2) chamar catalog.reserveLoad, que resolve a
  // disputa; (3) so se a reserva vencer, marcar vencedora e perdedoras. Se o
  // catalog recusar (FAILED_PRECONDITION: carga ja reservada; NOT_FOUND:
  // carga inexistente), o erro sobe sem tradução nem captura — e o mesmo
  // CatalogRpcError que o CatalogClient produziu, com o mesmo `code` que o
  // catalog devolveu. Mascarar esse erro (ex.: convertendo tudo para um erro
  // generico do bidding)
  // esconderia de quem perdeu a corrida que ele perdeu, e faria o controller
  // reportar um status diferente do que o catalog decidiu.
  async accept(
    loadId: string,
    carrierId: string,
    idempotencyKey: string,
  ): Promise<AcceptLoadResult> {
    // trackBiddingAcceptInFlight envolve o corpo inteiro: e um no-op em
    // producao (ver accept-in-flight-tracker.ts); so
    // gateway/test/full-flow.e2e.spec.ts liga a contagem, para provar que o
    // bidding processa aceitacoes concorrentes de verdade, e nao so que o
    // gateway as disparou sem esperar resposta (o que um contador do lado
    // do gateway sozinho nao provaria — ver o comentario do tracker).
    return trackBiddingAcceptInFlight(async () => {
      const quote = await this.quotes.findSubmittedQuote(loadId, carrierId);
      if (!quote) {
        // Sem cotacao SUBMITTED: ou a transportadora nunca cotou esta carga,
        // ou ela cotou e a corrida ja foi decidida (a cotacao dela virou
        // won ou lost antes deste accept rodar — o caso sequencial comum na
        // pratica, uma transportadora aceitando depois que outra ja venceu).
        // Os dois casos nao podem virar o mesmo erro: quem cotou e perdeu
        // precisa saber que perdeu, nao ouvir que nunca cotou.
        const existing = await this.quotes.findByLoadAndCarrier(loadId, carrierId);
        if (existing) {
          throw new QuoteAlreadyDecidedError(loadId, carrierId, existing.status);
        }
        throw new NoQuoteError(loadId, carrierId);
      }

      await this.catalog.reserveLoad({ loadId, carrierId, idempotencyKey });

      const losingQuotes = await this.quotes.markLosers(loadId, carrierId);
      quote.status = QuoteStatus.WON;
      return { winningQuote: quote, losingQuotes };
    });
  }

  // Toda comparacao com NaN retorna false em JavaScript: `priceCents <= 0`
  // sozinho deixa NaN e Infinity passarem direto para o INSERT (onde o
  // Postgres rejeita, mas com erro cru de coluna `int`, nao com invariante de
  // dominio). Por isso cada campo numerico e checado com `Number.isFinite`
  // antes de qualquer comparacao de valor (mesmo achado Critical da Task 1
  // deste plano, aplicado aqui ao bidding).
  private validate(input: SubmitQuoteInput): void {
    if (input.loadId.trim() === "") {
      throw new InvalidQuoteError("loadId", "must not be blank");
    }
    if (input.carrierId.trim() === "") {
      throw new InvalidQuoteError("carrierId", "must not be blank");
    }
    if (!Number.isFinite(input.priceCents)) {
      throw new InvalidQuoteError("priceCents", "must be a finite number");
    }
    if (input.priceCents <= 0) {
      throw new InvalidQuoteError("priceCents", "must be greater than zero");
    }
    if (!Number.isFinite(input.etaHours)) {
      throw new InvalidQuoteError("etaHours", "must be a finite number");
    }
    if (input.etaHours <= 0) {
      throw new InvalidQuoteError("etaHours", "must be greater than zero");
    }
  }
}
