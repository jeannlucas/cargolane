import { DataSource } from "typeorm";
import { CatalogClient } from "../src/quote/catalog.client";
import { Quote } from "../src/quote/quote.entity";
import { QuoteRepository } from "../src/quote/quote.repository";
import { QuoteService } from "../src/quote/quote.service";
import { startPostgres } from "./helpers/pg";

// price_cents e eta_hours sao int32 no .proto: no fio, NaN e Infinity chegam
// silenciosamente convertidos para 0 pela serializacao protobuf (verificado
// empiricamente com um servidor grpc minimo), entao esses casos degenerados
// nunca alcancam o servidor via gRPC de um jeito distinguivel de "enviou 0".
// Por isso, igual ao load.validation.spec.ts do catalog, eles sao testados
// aqui, chamando QuoteService diretamente, e nao em quote.submit.spec.ts.
describe("QuoteService.submit valida invariantes", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;
  let service: QuoteService;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres", url: pg.url, entities: [Quote], synchronize: true,
    });
    await ds.initialize();
    // Endereco fake: estes testes cobrem so a validacao de invariante de
    // QuoteService.submit, que nunca chama o catalog. Nenhuma conexao gRPC
    // real e aberta so por construir o cliente (grpc-js conecta sob demanda,
    // na primeira chamada).
    service = new QuoteService(new QuoteRepository(ds), new CatalogClient("127.0.0.1:0"));
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  const base = {
    loadId: "load-1",
    carrierId: "carrier-1",
    priceCents: 100000,
    etaHours: 24,
  };

  it.each([
    ["loadId vazio", { loadId: "  " }, "loadId"],
    ["carrierId vazio", { carrierId: "  " }, "carrierId"],
    ["priceCents zero", { priceCents: 0 }, "priceCents"],
    ["priceCents negativo", { priceCents: -1 }, "priceCents"],
    ["priceCents NaN", { priceCents: NaN }, "priceCents"],
    ["priceCents infinito", { priceCents: Infinity }, "priceCents"],
    ["priceCents infinito negativo", { priceCents: -Infinity }, "priceCents"],
    ["etaHours zero", { etaHours: 0 }, "etaHours"],
    ["etaHours negativo", { etaHours: -1 }, "etaHours"],
    ["etaHours NaN", { etaHours: NaN }, "etaHours"],
    ["etaHours infinito", { etaHours: Infinity }, "etaHours"],
    ["etaHours infinito negativo", { etaHours: -Infinity }, "etaHours"],
  ])("rejeita %s", async (_label, override, field) => {
    await expect(service.submit({ ...base, ...override }))
      .rejects.toMatchObject({ name: "InvalidQuoteError", field });
  });

  it("nao persiste nada quando a validacao falha", async () => {
    const before = await ds.getRepository(Quote).count();

    await expect(service.submit({ ...base, priceCents: -1 })).rejects.toThrow();
    await expect(service.submit({ ...base, priceCents: NaN })).rejects.toThrow();
    await expect(service.submit({ ...base, priceCents: Infinity })).rejects.toThrow();
    await expect(service.submit({ ...base, etaHours: NaN })).rejects.toThrow();
    await expect(service.submit({ ...base, etaHours: Infinity })).rejects.toThrow();

    expect(await ds.getRepository(Quote).count()).toBe(before);
  });
});
