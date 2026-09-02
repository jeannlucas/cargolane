// Violacao de invariante de dominio (ex.: priceCents <= 0, loadId vazio).
// Validacao de forma (campo ausente, tipo errado) e responsabilidade do
// gateway, nao do bidding.
export class InvalidQuoteError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`invalid quote: ${field} ${reason}`);
    this.name = "InvalidQuoteError";
  }
}

// Traduz a violacao da constraint @Unique(["loadId", "carrierId"]) do
// Postgres (codigo 23505): uma transportadora ja cotou esta carga.
export class DuplicateQuoteError extends Error {
  constructor(readonly loadId: string, readonly carrierId: string) {
    super(`carrier ${carrierId} already quoted load ${loadId}`);
    this.name = "DuplicateQuoteError";
  }
}
