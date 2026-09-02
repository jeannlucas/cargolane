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
