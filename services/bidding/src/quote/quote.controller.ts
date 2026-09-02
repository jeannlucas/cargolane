import { status } from "@grpc/grpc-js";
import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { DuplicateQuoteError, InvalidQuoteError } from "./quote.errors";
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
}
