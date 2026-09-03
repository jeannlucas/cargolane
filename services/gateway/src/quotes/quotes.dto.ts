import { IsInt, IsNotEmpty, IsString } from "class-validator";

// Validacao de forma (campo ausente, tipo errado, string vazia). A invariante
// de dominio (ex.: priceCents/etaHours devem ser maiores que zero) ja existe
// no bidding (ver services/bidding/src/quote/quote.service.ts:validate) e nao
// e duplicada aqui — mesmo criterio de loads.dto.ts para o catalog.
export class SubmitQuoteDto {
  @IsString()
  @IsNotEmpty()
  carrierId!: string;

  @IsInt()
  priceCents!: number;

  @IsInt()
  etaHours!: number;
}

export class AcceptLoadDto {
  @IsString()
  @IsNotEmpty()
  carrierId!: string;

  @IsString()
  @IsNotEmpty()
  idempotencyKey!: string;
}
