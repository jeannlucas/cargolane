import { INestApplication } from "@nestjs/common";
import request from "supertest";
import {
  peakAcceptInFlight, resetAcceptInFlightPeak,
} from "../src/quotes/accept-in-flight-tracker";
import { createApp } from "../src/create-app";
import {
  startCatalogAndBiddingForGatewayTests, TestCatalogAndBidding,
} from "./helpers/bidding";

// Este e o teste que fecha o Plano 2: prova que catalog, bidding e gateway
// funcionam juntos, e que a disputa pela carga acontece de ponta a ponta
// atraves da API HTTP publica — nao de um teste unitario contra um dos tres
// servicos isolado, nem de uma chamada gRPC direta que pule o gateway.
//
// Nenhum mock: catalog e bidding sobem de verdade (cada um com seu proprio
// Postgres via Testcontainers, atras de startCatalogAndBiddingForGatewayTests
// — ver test/helpers/bidding.ts), e o gateway fala com os dois por gRPC real,
// exatamente como em producao.
describe("Fluxo completo: disputa por HTTP entre catalog, bidding e gateway", () => {
  let servers: TestCatalogAndBidding;
  let app: INestApplication;

  // ACCEPT_INFLIGHT_TRACKING liga a contagem de chamadas RPC em voo dentro
  // de QuotesController.accept (ver src/quotes/accept-in-flight-tracker.ts).
  // Desligada por padrao (producao e os outros specs deste pacote nunca
  // pagam o custo); precisa estar "1" antes das requisicoes de accept()
  // deste teste, nao antes de createApp() — ao contrario de
  // CATALOG_GRPC_URL/BIDDING_GRPC_URL, trackAcceptRpcInFlight le
  // process.env a cada chamada, nao uma vez no bootstrap.
  const previousTracking = process.env.ACCEPT_INFLIGHT_TRACKING;

  beforeAll(async () => {
    // CATALOG_GRPC_URL/BIDDING_GRPC_URL precisam estar definidas ANTES de
    // createApp(): sao lidas dentro dos useFactory do
    // ClientsModule.registerAsync (services/gateway/src/app.module.ts),
    // chamados quando o Nest resolve os providers no bootstrap, dentro deste
    // createApp() — mesma ordem de test/quotes.e2e.spec.ts.
    servers = await startCatalogAndBiddingForGatewayTests();
    app = await createApp();
    await app.init();
    process.env.ACCEPT_INFLIGHT_TRACKING = "1";
  }, 60_000);

  afterAll(async () => {
    if (previousTracking === undefined) {
      delete process.env.ACCEPT_INFLIGHT_TRACKING;
    } else {
      process.env.ACCEPT_INFLIGHT_TRACKING = previousTracking;
    }
    await app.close();
    await servers.stop();
  });

  function validLoadPayload() {
    return {
      shipperId: "shipper-final",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weightKg: 12000,
      pickupWindowEnd: "2026-12-31T12:00:00Z",
      priceCeilingCents: 350000,
    };
  }

  // Tres transportadoras cotam a mesma carga. O preco/eta nao decide quem
  // vence: quem vence e quem chegar primeiro no AcceptLoad, exatamente como
  // no teste de corrida do catalog (services/catalog/test/load.reserve.spec.ts)
  // e do bidding (services/bidding/test/quote.accept.spec.ts) — este teste
  // repete o mesmo mecanismo, mas pela API HTTP publica, com os tres
  // servicos de pe.
  const CARRIERS = [
    { carrierId: "carrier-alpha", priceCents: 180000, etaHours: 30 },
    { carrierId: "carrier-beta", priceCents: 150000, etaHours: 20 },
    { carrierId: "carrier-gamma", priceCents: 300000, etaHours: 40 },
  ];

  it(
    "publica carga, tres cotam, tres aceitam ao mesmo tempo: uma 200, duas 409, "
      + "e a decisao vem do catalog",
    async () => {
      // 1. Publica a carga.
      const publishRes = await request(app.getHttpServer())
        .post("/loads")
        .send(validLoadPayload());
      expect(publishRes.status).toBe(201);
      expect(publishRes.body.status).toBe("open");
      const loadId = publishRes.body.id as string;

      // 2. As tres transportadoras cotam (sequencial: nao ha disputa aqui,
      // SubmitQuote nao tem restricao de unicidade entre carriers diferentes).
      for (const carrier of CARRIERS) {
        const quoteRes = await request(app.getHttpServer())
          .post(`/loads/${loadId}/quotes`)
          .send(carrier);
        expect(quoteRes.status).toBe(201);
        expect(quoteRes.body.status).toBe("submitted");
      }

      // 3. As tres aceitam AO MESMO TEMPO. As tres promises sao criadas
      // sincronamente, no mesmo map, antes de qualquer await: as tres
      // requisicoes HTTP saem para o socket antes que qualquer resposta
      // volte. Promise.allSettled (nao Promise.all) porque perder a corrida
      // aqui e um resultado esperado (409), nao uma falha da promise em si —
      // supertest resolve a promise em qualquer status HTTP, entao nenhuma
      // das tres de fato rejeita, mas Promise.allSettled e o jeito
      // instruido, e explicito, de expressar "todas terminam, nenhuma
      // cancela a corrida das outras".
      //
      // Isso garante que o CLIENTE disparou as tres sem esperar resposta —
      // mas nao prova, sozinho, que o SERVIDOR as processou em sobreposicao.
      // Uma versao anterior deste teste tentava provar isso medindo
      // start/end no cliente (Date.now() antes do await, de novo depois) e
      // conferindo que as tres janelas se sobrepunham. Um revisor mostrou
      // que essa checagem e quase tautologica: `start` e capturado de forma
      // sincrona, antes de qualquer I/O, entao as tres janelas sempre vao
      // comecar a poucos milissegundos de distancia, nao importa o que o
      // servidor faca depois — inclusive se o gateway serializar accept()
      // de ponta a ponta com uma fila/mutex no controller, o teste antigo
      // continuava passando. A prova real precisa vir de dentro do
      // servidor: resetAcceptInFlightPeak()/peakAcceptInFlight() (ver
      // src/quotes/accept-in-flight-tracker.ts) contam quantas chamadas RPC
      // AcceptLoad estao de fato em voo ao mesmo tempo dentro do gateway.
      resetAcceptInFlightPeak();
      const attempts = CARRIERS.map((carrier) =>
        request(app.getHttpServer())
          .post(`/loads/${loadId}/accept`)
          .send({ carrierId: carrier.carrierId, idempotencyKey: `k-${carrier.carrierId}` }));
      const results = await Promise.allSettled(attempts);

      // Prova de sobreposicao real, do lado do servidor: o pico de chamadas
      // RPC em voo dentro de accept() precisa ter chegado a 3 — as tres ao
      // mesmo tempo. Se o gateway tivesse serializado essa chamada (mutex,
      // fila, pool de conexao esgotado), o pico ficaria em 1 e esta
      // asserção cairia, mesmo com as tres respostas corretas (uma 200,
      // duas 409) — e foi exatamente isso que o revisor demonstrou antes
      // desta correção.
      expect(peakAcceptInFlight()).toBe(3);

      const responses = results.map((r) => {
        if (r.status !== "fulfilled") {
          throw new Error(`accept nao deveria rejeitar a promise: ${String(r.reason)}`);
        }
        return r.value;
      });

      const winners = responses.filter((r) => r.status === 200);
      const losers = responses.filter((r) => r.status === 409);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);

      const winningBody = winners[0].body as {
        winningQuote: { carrierId: string; status: string };
        losingQuotes: number;
      };
      expect(winningBody.winningQuote.status).toBe("won");
      expect(winningBody.losingQuotes).toBe(2);
      const winningCarrierId = winningBody.winningQuote.carrierId;
      expect(CARRIERS.map((c) => c.carrierId)).toContain(winningCarrierId);

      // 4. Amarra a decisao a origem: o carrier_id que o catalog registrou
      // como dono da carga precisa ser exatamente o mesmo cuja cotacao ficou
      // "won" no bidding. Sem isso, o teste provaria so que uma das tres
      // venceu — nao que foi o UPDATE condicional do catalog quem decidiu
      // (o achado da Task 4: o bidding poderia, em tese, ter resolvido a
      // corrida sozinho no proprio banco, sem o catalog participar dela).
      const loadCheck = await request(app.getHttpServer()).get(`/loads/${loadId}`);
      expect(loadCheck.status).toBe(200);
      expect(loadCheck.body.status).toBe("reserved");
      expect(loadCheck.body.carrierId).toBe(winningCarrierId);

      // 5. As tres cotacoes terminam won/lost/lost, e a "won" e da mesma
      // transportadora que o catalog registrou.
      const quotesCheck = await request(app.getHttpServer()).get(`/loads/${loadId}/quotes`);
      expect(quotesCheck.status).toBe(200);
      const quotes = quotesCheck.body as { carrierId: string; status: string }[];
      const won = quotes.filter((q) => q.status === "won");
      const lost = quotes.filter((q) => q.status === "lost");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(2);
      expect(won[0].carrierId).toBe(winningCarrierId);
    },
    30_000,
  );
});
