import * as grpc from "@grpc/grpc-js";
import { status } from "@grpc/grpc-js";
import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { DuplicateQuoteError, InvalidQuoteError, NoQuoteError } from "./quote.errors";
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
      if (this.isCatalogServiceError(e)) {
        // Repassa o mesmo codigo que o catalog decidiu (FAILED_PRECONDITION,
        // NOT_FOUND, etc.): quem perdeu a corrida precisa saber que perdeu,
        // nao receber um status generico do bidding.
        throw new RpcException({ code: e.code, message: e.details || e.message });
      }
      throw e;
    }
  }

  private isCatalogServiceError(e: unknown): e is grpc.ServiceError {
    return e instanceof Error
      && "code" in e
      && typeof (e as { code: unknown }).code === "number";
  }
}
