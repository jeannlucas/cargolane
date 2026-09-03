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

// Aceitar uma carga sem antes ter cotado. Erro de precondicao (o pedido em
// si e valido, falta o estado previo — uma cotacao submitted), nao de
// argumento invalido: por isso o controller traduz para FAILED_PRECONDITION,
// nao INVALID_ARGUMENT. Lancado antes de qualquer chamada ao catalog: sem
// cotacao previa, o catalog nem precisa ser consultado.
//
// So descreve corretamente quem de fato nunca cotou. QuoteService.accept
// so lanca este erro depois de confirmar (via QuoteRepository.findByLoadAndCarrier)
// que a transportadora nao tem cotacao nenhuma para esta carga — ver
// QuoteAlreadyDecidedError abaixo para o caso de quem cotou mas a corrida ja
// foi decidida.
export class NoQuoteError extends Error {
  constructor(readonly loadId: string, readonly carrierId: string) {
    super(`carrier ${carrierId} has no submitted quote for load ${loadId}`);
    this.name = "NoQuoteError";
  }
}

// Transportadora que cotou a carga, mas cuja cotacao ja nao esta mais
// `submitted` quando ela tenta aceitar: ou ela perdeu a corrida (a cotacao
// virou `lost`, porque outra transportadora ja teve a reserva confirmada
// pelo catalog), ou ela mesma ja tinha vencido antes (a cotacao virou `won`,
// numa aceitacao repetida). Em ambos os casos a carga ja foi decidida — a
// diferenca em relacao a NoQuoteError e que aqui existe uma cotacao real,
// so nao mais aberta para aceitar.
//
// Isso importa sobretudo no caso sequencial (o comum na pratica: uma
// transportadora aceita, e so depois — nao ao mesmo tempo — outra tenta
// aceitar tambem). Sem esta distincao, QuoteService.accept confundia esse
// caso com "nunca cotou": findSubmittedQuote nao acha a cotacao (porque
// markLosers ja marcou ela como lost), e o codigo caia direto em
// NoQuoteError antes mesmo de consultar o catalog — que diz a quem cotou e
// perdeu que "nao tem cotacao", quando na verdade ela cotou e a carga foi
// para outra transportadora.
export class QuoteAlreadyDecidedError extends Error {
  constructor(
    readonly loadId: string,
    readonly carrierId: string,
    readonly quoteStatus: string,
  ) {
    super(
      `load ${loadId} was already decided; carrier ${carrierId}'s quote is `
        + `${quoteStatus}, not submitted`,
    );
    this.name = "QuoteAlreadyDecidedError";
  }
}
