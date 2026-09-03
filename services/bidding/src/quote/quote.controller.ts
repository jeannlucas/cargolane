import { status } from "@grpc/grpc-js";
import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { CatalogRpcError } from "./catalog.client";
import {
  DuplicateQuoteError, InvalidQuoteError, NoQuoteError, QuoteAlreadyDecidedError,
} from "./quote.errors";
import { QuoteMessage, toQuoteMessage } from "./quote.mapper";
import { QuoteService } from "./quote.service";

interface SubmitQuoteRequest {
  load_id: string;
  carrier_id: string;
  price_cents: number;
  eta_hours: number;
}

interface ListQuotesRequest {
  load_id: string;
}

interface ListQuotesResponse {
  quotes: QuoteMessage[];
}

interface AcceptLoadRequest {
  load_id: string;
  carrier_id: string;
  idempotency_key: string;
}

interface AcceptLoadResponse {
  winning_quote: QuoteMessage;
  losing_quotes: number;
}

@Controller()
export class QuoteController {
  constructor(private readonly quotes: QuoteService) {}

  @GrpcMethod("BiddingService", "SubmitQuote")
  async submitQuote(req: SubmitQuoteRequest): Promise<QuoteMessage> {
    try {
      const quote = await this.quotes.submit({
        loadId: req.load_id,
        carrierId: req.carrier_id,
        priceCents: req.price_cents,
        etaHours: req.eta_hours,
      });
      return toQuoteMessage(quote);
    } catch (e) {
      if (e instanceof DuplicateQuoteError) {
        throw new RpcException({ code: status.ALREADY_EXISTS, message: e.message });
      }
      if (e instanceof InvalidQuoteError) {
        throw new RpcException({ code: status.INVALID_ARGUMENT, message: e.message });
      }
      throw e;
    }
  }

  @GrpcMethod("BiddingService", "ListQuotes")
  async listQuotes(req: ListQuotesRequest): Promise<ListQuotesResponse> {
    const quotes = await this.quotes.listByLoad(req.load_id);
    return { quotes: quotes.map(toQuoteMessage) };
  }

  @GrpcMethod("BiddingService", "AcceptLoad")
  async acceptLoad(req: AcceptLoadRequest): Promise<AcceptLoadResponse> {
    try {
      const { winningQuote, losingQuotes } = await this.quotes.accept(
        req.load_id,
        req.carrier_id,
        req.idempotency_key,
      );
      return {
        winning_quote: toQuoteMessage(winningQuote),
        losing_quotes: losingQuotes,
      };
    } catch (e) {
      if (e instanceof NoQuoteError) {
        throw new RpcException({ code: status.FAILED_PRECONDITION, message: e.message });
      }
      if (e instanceof QuoteAlreadyDecidedError) {
        // Mesmo codigo de NoQuoteError (precondicao: o pedido em si e
        // valido, falta o estado previo), mas com uma mensagem que descreve
        // o que de fato aconteceu — a transportadora cotou, so a carga ja
        // foi decidida — em vez de negar que ela tenha cotado.
        throw new RpcException({ code: status.FAILED_PRECONDITION, message: e.message });
      }
      if (e instanceof CatalogRpcError) {
        // Repassa o mesmo codigo que o catalog decidiu (FAILED_PRECONDITION,
        // NOT_FOUND, etc.): quem perdeu a corrida precisa saber que perdeu,
        // nao receber um status generico do bidding. Classificado por
        // `instanceof CatalogRpcError` (marca explicita de origem posta pelo
        // proprio CatalogClient), nunca por presenca estrutural de um campo
        // `code` numerico: um erro futuro qualquer com `.code` numerico nao
        // pode vazar como status gRPC arbitrario so por acidente de forma.
        throw new RpcException({ code: e.code, message: e.message });
      }
      throw e;
    }
  }
}
