import { status } from "@grpc/grpc-js";
import { DataSource } from "typeorm";
import { Quote } from "../src/quote/quote.entity";
import { BiddingGrpcClient, startBiddingGrpcServer } from "./helpers/grpc";

describe("BiddingService gRPC", () => {
  let client: BiddingGrpcClient;
  let ds: DataSource;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const server = await startBiddingGrpcServer();
    client = server.client;
    ds = server.ds;
    stop = server.stop;
  }, 60_000);

  afterAll(async () => {
    await stop();
  });

  it("cotacao aceita nasce com status submitted", async () => {
    const quote = await client.submitQuote({
      load_id: "load-1",
      carrier_id: "carrier-1",
      price_cents: 100000,
      eta_hours: 24,
    });

    expect(quote.status).toBe("submitted");
    expect(quote.id).toEqual(expect.any(String));
    expect(quote.load_id).toBe("load-1");
    expect(quote.carrier_id).toBe("carrier-1");
  });

  it("segunda cotacao da mesma transportadora na mesma carga devolve ALREADY_EXISTS", async () => {
    await client.submitQuote({
      load_id: "load-2",
      carrier_id: "carrier-2",
      price_cents: 100000,
      eta_hours: 24,
    });

    await expect(client.submitQuote({
      load_id: "load-2",
      carrier_id: "carrier-2",
      price_cents: 90000,
      eta_hours: 20,
    })).rejects.toMatchObject({ code: status.ALREADY_EXISTS });
  });

  it("a mesma transportadora pode cotar cargas diferentes", async () => {
    await client.submitQuote({
      load_id: "load-3",
      carrier_id: "carrier-3",
      price_cents: 100000,
      eta_hours: 24,
    });

    await expect(client.submitQuote({
      load_id: "load-4",
      carrier_id: "carrier-3",
      price_cents: 110000,
      eta_hours: 22,
    })).resolves.toMatchObject({ load_id: "load-4", carrier_id: "carrier-3" });
  });

  it("ListQuotes devolve so as cotacoes da carga pedida, mais barata primeiro", async () => {
    await client.submitQuote({
      load_id: "load-5",
      carrier_id: "carrier-a",
      price_cents: 150000,
      eta_hours: 24,
    });
    await client.submitQuote({
      load_id: "load-5",
      carrier_id: "carrier-b",
      price_cents: 100000,
      eta_hours: 30,
    });
    await client.submitQuote({
      load_id: "load-6",
      carrier_id: "carrier-c",
      price_cents: 50000,
      eta_hours: 10,
    });

    const response = await client.listQuotes({ load_id: "load-5" });

    expect(response.quotes).toHaveLength(2);
    expect(response.quotes.map((q) => q.carrier_id)).toEqual(["carrier-b", "carrier-a"]);
    expect(response.quotes[0].price_cents).toBeLessThanOrEqual(response.quotes[1].price_cents);
  });

  it("ListQuotes desempata preco igual por created_at, mais antiga primeiro", async () => {
    // Duas chamadas seguidas da mesma consulta, contra uma tabela que nao
    // mudou no intervalo, tendem a devolver a mesma ordem fisica por acaso
    // (mesmo plano, mesmos dados) mesmo sem nenhum ORDER BY de desempate —
    // comparar chamada com chamada prova repetibilidade, nao ordenacao
    // deterministica, e passa mesmo com o bug de volta (confirmado
    // manualmente). O teste certo afirma a ordem esperada.
    //
    // carrier-tie-a e inserida primeiro (ordem fisica/insercao: a, b), mas
    // recebe o created_at MAIS NOVO; carrier-tie-b e inserida depois e
    // recebe o created_at MAIS ANTIGO. A ordem correta por created_at ASC
    // (b, a) fica assim deliberadamente invertida em relacao a ordem de
    // insercao/fisica — se o desempate por created_at sumir do ORDER BY, a
    // consulta tende a devolver a ordem fisica (a, b), que diverge do
    // esperado e falha o teste. Sem essa inversao proposital, um teste que
    // so confirma "created_at ASC == ordem de insercao" nao teria como
    // distinguir "ordenei por created_at" de "a ordem fisica coincide com a
    // de insercao", que e exatamente o problema que causou este teste ser
    // reescrito.
    //
    // Os valores de created_at sao sobrescritos explicitamente apos o
    // submit, em vez de confiar na resolucao do relogio/timestamptz entre
    // dois inserts em sequencia rapida — um teste que depende disso e
    // intermitente por construcao.
    const loadId = `load-tie-${Math.random()}`;
    const a = await client.submitQuote({
      load_id: loadId,
      carrier_id: "carrier-tie-a",
      price_cents: 80000,
      eta_hours: 12,
    });
    const b = await client.submitQuote({
      load_id: loadId,
      carrier_id: "carrier-tie-b",
      price_cents: 80000,
      eta_hours: 15,
    });
    await ds.getRepository(Quote).update(
      { id: a.id },
      { createdAt: new Date("2026-01-01T00:00:01.000Z") },
    );
    await ds.getRepository(Quote).update(
      { id: b.id },
      { createdAt: new Date("2026-01-01T00:00:00.000Z") },
    );

    const response = await client.listQuotes({ load_id: loadId });

    expect(response.quotes.map((q) => q.carrier_id)).toEqual([
      "carrier-tie-b", "carrier-tie-a",
    ]);
  });

  it.each([
    ["price_cents zero", { price_cents: 0, eta_hours: 24 }],
    ["price_cents negativo", { price_cents: -100, eta_hours: 24 }],
    ["eta_hours zero", { price_cents: 100000, eta_hours: 0 }],
    ["eta_hours negativo", { price_cents: 100000, eta_hours: -1 }],
  ])("rejeita invariante invalida (%s) com INVALID_ARGUMENT e nao persiste nada", async (_label, overrides) => {
    const loadId = `load-invalid-${Math.random()}`;
    const before = await ds.getRepository(Quote).countBy({ loadId });

    await expect(client.submitQuote({
      load_id: loadId,
      carrier_id: "carrier-invalid",
      price_cents: overrides.price_cents,
      eta_hours: overrides.eta_hours,
    })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });

    const after = await ds.getRepository(Quote).countBy({ loadId });
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it("rejeita load_id vazio com INVALID_ARGUMENT", async () => {
    await expect(client.submitQuote({
      load_id: "",
      carrier_id: "carrier-x",
      price_cents: 100000,
      eta_hours: 24,
    })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it("rejeita carrier_id vazio com INVALID_ARGUMENT", async () => {
    await expect(client.submitQuote({
      load_id: "load-y",
      carrier_id: "",
      price_cents: 100000,
      eta_hours: 24,
    })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });
});
