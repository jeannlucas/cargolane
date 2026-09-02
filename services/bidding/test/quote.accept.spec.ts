import { status } from "@grpc/grpc-js";
import { RpcException } from "@nestjs/microservices";
import { DataSource } from "typeorm";
import { CatalogClient } from "../src/quote/catalog.client";
import { QuoteController } from "../src/quote/quote.controller";
import { NoQuoteError } from "../src/quote/quote.errors";
import { Quote, QuoteStatus } from "../src/quote/quote.entity";
import { QuoteRepository } from "../src/quote/quote.repository";
import { QuoteService } from "../src/quote/quote.service";
import { CatalogTestGrpcClient, startCatalogForBiddingTests, TestCatalogServer } from "./helpers/catalog";
import { startPostgres } from "./helpers/pg";

// Estes testes exercitam a orquestracao completa: bidding real (Postgres
// proprio) chamando catalog real (Postgres proprio, servico de verdade em
// porta efemera) por gRPC. Nenhum dos dois lados e mock — a disputa por uma
// carga so e real se o UPDATE condicional do catalog participar dela (ver
// services/catalog/src/load/load.repository.ts).
describe("QuoteService.accept orquestra AcceptLoad contra o catalog", () => {
  let biddingDs: DataSource;
  let stopBiddingPg: () => Promise<void>;
  let repo: QuoteRepository;
  let service: QuoteService;
  let controller: QuoteController;
  let catalogServer: TestCatalogServer;
  let catalog: CatalogTestGrpcClient;
  let catalogClient: CatalogClient;

  beforeAll(async () => {
    const pg = await startPostgres();
    stopBiddingPg = pg.stop;
    biddingDs = new DataSource({
      type: "postgres", url: pg.url, entities: [Quote], synchronize: true,
    });
    await biddingDs.initialize();
    repo = new QuoteRepository(biddingDs);

    catalogServer = await startCatalogForBiddingTests();
    catalog = catalogServer.client;
    catalogClient = new CatalogClient(catalogServer.url);

    service = new QuoteService(repo, catalogClient);
    controller = new QuoteController(service);
  }, 60_000);

  afterAll(async () => {
    catalogClient.close();
    await catalogServer.stop();
    await biddingDs.destroy();
    await stopBiddingPg();
  });

  function futureIso(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  async function publishOpenLoad(): Promise<string> {
    const load = await catalog.publishLoad({
      shipper_id: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weight_kg: 12000,
      pickup_window_end: futureIso(),
      price_ceiling_cents: 500000,
    });
    return load.id;
  }

  async function warmPool(ds: DataSource, size: number): Promise<void> {
    await Promise.all(Array.from({ length: size }, () => ds.query("SELECT 1")));
  }

  function acceptViaController(loadId: string, carrierId: string, idempotencyKey: string) {
    return controller.acceptLoad({
      load_id: loadId, carrier_id: carrierId, idempotency_key: idempotencyKey,
    });
  }

  // Le o codigo gRPC de uma rejeicao do controller. Usado no teste de
  // corrida: internamente, a perdedora pode chegar a este resultado por dois
  // caminhos (NoQuoteError do bidding, se a vencedora ja tiver marcado a
  // cotacao dela como lost antes do seu proprio check rodar; ou o
  // grpc.ServiceError cru do catalog, se ela chegar a discar ReserveLoad
  // antes disso) — sao dois formatos de erro internos diferentes, sem `code`
  // em comum entre si. O contrato publico e o unico lugar onde os dois se
  // tornam a mesma coisa (FAILED_PRECONDITION), porque e o controller quem
  // normaliza os dois em RpcException. Testar no nivel do QuoteService direto
  // (sem passar pelo controller) tornaria este teste dependente de qual dos
  // dois caminhos internos a corrida calhou de tomar — exatamente o tipo de
  // acoplamento a um detalhe de implementacao que fez este teste ser
  // reescrito para passar pelo controller.
  async function rpcCodeOf(promise: Promise<unknown>): Promise<number | undefined> {
    try {
      await promise;
      return undefined;
    } catch (e) {
      if (!(e instanceof RpcException)) {
        throw e;
      }
      const err = e.getError();
      return typeof err === "object" && err !== null
        ? (err as { code?: number }).code
        : undefined;
    }
  }

  it("aceitar sem ter cotado falha, e o catalog nao e chamado", async () => {
    const loadId = await publishOpenLoad();

    await expect(service.accept(loadId, "carrier-sem-cotacao", "k1"))
      .rejects.toBeInstanceOf(NoQuoteError);

    // Prova que o catalog nunca foi chamado: se AcceptLoad tivesse discado
    // ReserveLoad, a carga teria saido de "open".
    const load = await catalog.getLoad({ id: loadId });
    expect(load.status).toBe("open");

    // No limite publico (o controller gRPC), o mesmo cenario vira
    // FAILED_PRECONDITION — o contrato que o cliente do bidding realmente ve.
    await expect(rpcCodeOf(acceptViaController(loadId, "carrier-sem-cotacao", "k2")))
      .resolves.toBe(status.FAILED_PRECONDITION);
  });

  it("a vencedora fica won e as demais lost", async () => {
    const loadId = await publishOpenLoad();
    await repo.submit({ loadId, carrierId: "c1", priceCents: 150000, etaHours: 24 });
    await repo.submit({ loadId, carrierId: "c2", priceCents: 120000, etaHours: 20 });
    await repo.submit({ loadId, carrierId: "c3", priceCents: 180000, etaHours: 30 });

    const res = await service.accept(loadId, "c2", "k1");

    expect(res.winningQuote.status).toBe(QuoteStatus.WON);
    expect(res.winningQuote.carrierId).toBe("c2");
    expect(res.losingQuotes).toBe(2);

    const all = await repo.listByLoad(loadId);
    expect(all.filter((q) => q.status === QuoteStatus.LOST)).toHaveLength(2);
    expect(all.filter((q) => q.status === QuoteStatus.WON)).toHaveLength(1);
    expect(all.find((q) => q.carrierId === "c2")?.status).toBe(QuoteStatus.WON);

    const load = await catalog.getLoad({ id: loadId });
    expect(load.status).toBe("reserved");
    expect(load.carrier_id).toBe("c2");
  });

  it("duas aceitacoes simultaneas: uma vence, a outra recebe FAILED_PRECONDITION", async () => {
    const loadId = await publishOpenLoad();
    await repo.submit({ loadId, carrierId: "ca", priceCents: 100000, etaHours: 24 });
    await repo.submit({ loadId, carrierId: "cb", priceCents: 110000, etaHours: 22 });

    // Aquece o pool do catalog: a corrida de verdade e decidida pelo UPDATE
    // condicional dentro dele, nao pelo bidding (ver
    // services/catalog/test/load.reserve.spec.ts).
    await warmPool(catalogServer.ds, 5);

    const results = await Promise.allSettled([
      acceptViaController(loadId, "ca", "k-a"),
      acceptViaController(loadId, "cb", "k-b"),
    ]);

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Quem decide e o catalog: a perdedora recebe o mesmo FAILED_PRECONDITION
    // que LoadNotOpenError vira no controller do catalog, sem mascaramento
    // (ver rpcCodeOf acima: a perdedora pode chegar aqui por dois caminhos
    // internos diferentes, e o codigo publico e onde os dois convergem).
    const loserReason = (losers[0] as PromiseRejectedResult).reason;
    expect(loserReason).toBeInstanceOf(RpcException);
    expect((loserReason as RpcException).getError()).toMatchObject({
      code: status.FAILED_PRECONDITION,
    });

    const all = await repo.listByLoad(loadId);
    expect(all.filter((q) => q.status === QuoteStatus.WON)).toHaveLength(1);
    expect(all.filter((q) => q.status === QuoteStatus.LOST)).toHaveLength(1);

    // A afirmacao anterior (exatamente uma vence, com FAILED_PRECONDITION)
    // fica igualmente satisfeita se o bidding tivesse resolvido a corrida
    // sozinho no proprio banco — nao prova "quem decide e o catalog".
    // Amarrar a decisao a sua origem: o carrier que o catalog registrou como
    // dono da carga (carrier_id, no banco do catalog) precisa ser o mesmo
    // cuja cotacao ficou WON no bidding. Vale nos dois caminhos internos que
    // levam a perdedora ao FAILED_PRECONDITION (ver rpcCodeOf acima), porque
    // em ambos quem efetivamente reservou a carga foi o catalog — o unico
    // que pode ganhar o UPDATE condicional dele e quem chegou a discar
    // ReserveLoad primeiro.
    const winnerQuote = all.find((q) => q.status === QuoteStatus.WON);
    const load = await catalog.getLoad({ id: loadId });
    expect(load.status).toBe("reserved");
    expect(load.carrier_id).toBe(winnerQuote?.carrierId);
  });

  it("quando o catalog recusa, nenhuma cotacao muda de status", async () => {
    const loadId = await publishOpenLoad();
    await repo.submit({ loadId, carrierId: "ca", priceCents: 100000, etaHours: 24 });
    await repo.submit({ loadId, carrierId: "cb", priceCents: 110000, etaHours: 22 });

    // Carga reservada por outro caminho, sem passar pelo bidding: prova que
    // service.accept nao assume sucesso, so age depois que o catalog confirma.
    await catalog.reserveLoad({
      load_id: loadId, carrier_id: "outro-caminho", idempotency_key: "x",
    });

    await expect(service.accept(loadId, "ca", "k1"))
      .rejects.toMatchObject({ code: status.FAILED_PRECONDITION });

    const all = await repo.listByLoad(loadId);
    expect(all.every((q) => q.status === QuoteStatus.SUBMITTED)).toBe(true);

    // Mesma prova no limite publico: o controller repassa o FAILED_PRECONDITION
    // do catalog sem mascarar, e continua sem mudar nenhum status.
    await expect(rpcCodeOf(acceptViaController(loadId, "cb", "k2")))
      .resolves.toBe(status.FAILED_PRECONDITION);
    const stillSubmitted = await repo.listByLoad(loadId);
    expect(stillSubmitted.every((q) => q.status === QuoteStatus.SUBMITTED)).toBe(true);
  });

  it("aceitar carga inexistente no catalog falha com NOT_FOUND", async () => {
    // loadId valido (formato uuid) mas nunca publicado no catalog: nada
    // impede o bidding de ter uma cotacao SUBMITTED para um loadId que o
    // catalog nao conhece (as duas tabelas nao tem FK entre si), entao
    // findSubmittedQuote encontra a cotacao normalmente e a chamada chega
    // ate o catalog.ReserveLoad, onde o catalog devolve NOT_FOUND (mesmo
    // loadId inexistente que services/catalog/test/load.reserve.spec.ts
    // usa para o mesmo cenario).
    const nonExistentLoadId = "00000000-0000-0000-0000-000000000000";
    await repo.submit({
      loadId: nonExistentLoadId, carrierId: "carrier-x", priceCents: 100000, etaHours: 24,
    });

    await expect(rpcCodeOf(acceptViaController(nonExistentLoadId, "carrier-x", "k1")))
      .resolves.toBe(status.NOT_FOUND);
  });
});
