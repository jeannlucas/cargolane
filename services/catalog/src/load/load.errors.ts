export class LoadNotOpenError extends Error {
  constructor(readonly loadId: string) {
    super(`load ${loadId} is not open for reservation`);
    this.name = "LoadNotOpenError";
  }
}

export class LoadNotFoundError extends Error {
  constructor(readonly loadId: string) {
    super(`load ${loadId} not found`);
    this.name = "LoadNotFoundError";
  }
}

// Violacao de invariante de dominio (ex.: peso <= 0, janela de coleta no
// passado). Validacao de forma (campo ausente, tipo errado) e
// responsabilidade do gateway, nao do catalog.
export class InvalidLoadError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`invalid load: ${field} ${reason}`);
    this.name = "InvalidLoadError";
  }
}
