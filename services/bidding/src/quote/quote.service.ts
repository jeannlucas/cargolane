import { Injectable } from "@nestjs/common";
import { InvalidQuoteError } from "./quote.errors";
import { Quote } from "./quote.entity";
import { QuoteRepository, SubmitQuoteInput } from "./quote.repository";

@Injectable()
export class QuoteService {
  constructor(private readonly quotes: QuoteRepository) {}

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
