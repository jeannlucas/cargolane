import {
  Body, Controller, Get, HttpCode, HttpStatus, Inject, OnModuleInit, Param,
  ParseUUIDPipe, Post,
} from "@nestjs/common";
import { ClientGrpc } from "@nestjs/microservices";
import { firstValueFrom, Observable } from "rxjs";
import { BIDDING_CLIENT } from "../bidding.constants";
import { trackAcceptRpcInFlight } from "./accept-in-flight-tracker";
import { AcceptLoadDto, SubmitQuoteDto } from "./quotes.dto";

// Forma crua devolvida pelo bidding (snake_case, igual ao .proto). Nao
// reexportada: fica encapsulada aqui, o REST fala camelCase (toQuoteResponse
// abaixo faz a traducao) — mesmo padrao de loads.controller.ts para o
// catalog.
interface BiddingQuoteMessage {
  id: string;
  load_id: string;
  carrier_id: string;
  price_cents: number;
  eta_hours: number;
  status: string;
}

interface AcceptLoadMessage {
  winning_quote: BiddingQuoteMessage;
  losing_quotes: number;
}

// Stub gerado pelo ClientGrpc.getService: os nomes dos metodos sao
// exatamente os nomes das rpc no .proto (PascalCase), nao camelCase — mesma
// observacao de loads.controller.ts para o CatalogGrpcService.
interface BiddingGrpcService {
  SubmitQuote(data: {
    load_id: string;
    carrier_id: string;
    price_cents: number;
    eta_hours: number;
  }): Observable<BiddingQuoteMessage>;
  ListQuotes(data: { load_id: string }): Observable<{ quotes: BiddingQuoteMessage[] }>;
  AcceptLoad(data: {
    load_id: string;
    carrier_id: string;
    idempotency_key: string;
  }): Observable<AcceptLoadMessage>;
}

export interface QuoteResponse {
  id: string;
  loadId: string;
  carrierId: string;
  priceCents: number;
  etaHours: number;
  status: string;
}

export interface AcceptLoadResponse {
  winningQuote: QuoteResponse;
  losingQuotes: number;
}

function toQuoteResponse(quote: BiddingQuoteMessage): QuoteResponse {
  return {
    id: quote.id,
    loadId: quote.load_id,
    carrierId: quote.carrier_id,
    priceCents: quote.price_cents,
    etaHours: quote.eta_hours,
    status: quote.status,
  };
}

// @Controller("loads"), nao "loads/:id/quotes": Nest resolve os tres
// metodos (SubmitQuote, ListQuotes, AcceptLoad) sob o mesmo prefixo de
// LoadsController sem colisao de rota, porque nenhum deles repete um path
// que LoadsController ja declara ("loads", "loads/:id" GET, "loads" POST).
@Controller("loads")
export class QuotesController implements OnModuleInit {
  private bidding!: BiddingGrpcService;

  constructor(@Inject(BIDDING_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.bidding = this.client.getService<BiddingGrpcService>("BiddingService");
  }

  // ParseUUIDPipe corta um :id malformado com 400 antes de qualquer chamada
  // ao bidding, pelo mesmo motivo de LoadsController.getById: sem isso o id
  // malformado chegaria ao bidding como um load_id de texto livre (o bidding
  // nao tem coluna uuid para load_id, ver quote.entity.ts), o que mascararia
  // o erro estrutural como se fosse uma carga so inexistente.
  @Post(":id/quotes")
  @HttpCode(HttpStatus.CREATED)
  async submitQuote(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: SubmitQuoteDto,
  ): Promise<QuoteResponse> {
    const quote = await firstValueFrom(
      this.bidding.SubmitQuote({
        load_id: id,
        carrier_id: dto.carrierId,
        price_cents: dto.priceCents,
        eta_hours: dto.etaHours,
      }),
    );
    return toQuoteResponse(quote);
  }

  @Get(":id/quotes")
  async listQuotes(@Param("id", new ParseUUIDPipe()) id: string): Promise<QuoteResponse[]> {
    const { quotes } = await firstValueFrom(this.bidding.ListQuotes({ load_id: id }));
    return quotes.map(toQuoteResponse);
  }

  @Post(":id/accept")
  @HttpCode(HttpStatus.OK)
  async accept(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: AcceptLoadDto,
  ): Promise<AcceptLoadResponse> {
    // trackAcceptRpcInFlight envolve exatamente a chamada RPC — o trabalho
    // real desta rota, incluindo a ida e volta ate o bidding (que por sua
    // vez disputa a carga contra o catalog). E um no-op em producao (ver
    // accept-in-flight-tracker.ts); so test/full-flow.e2e.spec.ts liga a
    // contagem, para provar concorrencia real do lado do servidor.
    const result = await trackAcceptRpcInFlight(() =>
      firstValueFrom(
        this.bidding.AcceptLoad({
          load_id: id,
          carrier_id: dto.carrierId,
          idempotency_key: dto.idempotencyKey,
        }),
      ),
    );
    return {
      winningQuote: toQuoteResponse(result.winning_quote),
      losingQuotes: result.losing_quotes,
    };
  }
}
