import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApp } from "../src/create-app";
import {
  startCatalogAndBiddingForGatewayTests, TestCatalogAndBidding,
} from "./helpers/bidding";

// Porta 1: mesma escolha (e mesmo motivo) de test/loads.e2e.spec.ts —
// privilegiada, entao qualquer conexao para ela falha na hora com connection
// refused, sem depender de nenhuma corrida de porta efemera "provavelmente
// livre".
const UNREACHABLE_URL = "127.0.0.1:1";

function validLoadPayload() {
  return {
    shipperId: "shipper-1",
    origin: "Maringa/PR",
    destination: "Curitiba/PR",
    weightKg: 12000,
    pickupWindowEnd: "2026-12-31T12:00:00Z",
    priceCeilingCents: 350000,
  };
}

function validQuotePayload(carrierId = "carrier-1") {
  return { carrierId, priceCents: 200000, etaHours: 24 };
}

describe("Gateway REST /loads/:id/quotes e /loads/:id/accept", () => {
  let servers: TestCatalogAndBidding;
  let app: INestApplication;
  let validationOnlyApp: INestApplication;

  beforeAll(async () => {
    // CATALOG_GRPC_URL/BIDDING_GRPC_URL precisam estar definidas ANTES de
    // createApp(): sao lidas dentro dos useFactory do ClientsModule.registerAsync
    // (services/gateway/src/app.module.ts), chamados quando o Nest resolve os
    // providers no bootstrap — que acontece dentro deste createApp().
    servers = await startCatalogAndBiddingForGatewayTests();
    app = await createApp();
    await app.init();

    // Segunda instancia da app, apontando catalog e bidding para um endereco
    // onde nada esta escutando. Usada nos testes de validacao de forma (DTO/
    // ValidationPipe/ParseUUIDPipe), para provar que a rejeicao 400 acontece
    // no gateway, sem depender de nenhum dos dois servicos downstream
    // estarem no ar — mesma tecnica (e mesmo motivo) de
    // test/loads.e2e.spec.ts: um teste de 400 que so confere o status HTTP
    // passaria igual se o bidding rejeitasse a mesma violacao por conta
    // propria (ex.: "carrierId vazio" tambem e invariante do bidding, ver
    // quote.service.ts:validate), escondendo um ValidationPipe removido.
    const previousCatalogUrl = process.env.CATALOG_GRPC_URL;
    const previousBiddingUrl = process.env.BIDDING_GRPC_URL;
    process.env.CATALOG_GRPC_URL = UNREACHABLE_URL;
    process.env.BIDDING_GRPC_URL = UNREACHABLE_URL;
    validationOnlyApp = await createApp();
    await validationOnlyApp.init();
    process.env.CATALOG_GRPC_URL = previousCatalogUrl;
    process.env.BIDDING_GRPC_URL = previousBiddingUrl;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await validationOnlyApp.close();
    await servers.stop();
  });

  async function publishLoad(): Promise<string> {
    const res = await request(app.getHttpServer()).post("/loads").send(validLoadPayload());
    return res.body.id as string;
  }

  it("POST /loads/:id/quotes com id malformado devolve 400, nao 500, sem depender do bidding", async () => {
    const res = await request(validationOnlyApp.getHttpServer())
      .post("/loads/not-a-valid-id/quotes")
      .send(validQuotePayload());

    expect(res.status).toBe(400);
  });

  it("POST /loads/:id/quotes com campo desconhecido no corpo devolve 400, sem depender do bidding", async () => {
    const res = await request(validationOnlyApp.getHttpServer())
      .post(`/loads/${randomUUID()}/quotes`)
      .send({ ...validQuotePayload(), unexpectedField: "nope" });

    expect(res.status).toBe(400);
  });

  it("POST /loads/:id/quotes valido devolve 201", async () => {
    const loadId = await publishLoad();

    const res = await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send(validQuotePayload("carrier-1"));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      loadId,
      carrierId: "carrier-1",
      priceCents: 200000,
      etaHours: 24,
      status: "submitted",
    });
    expect(res.body.id).toEqual(expect.any(String));
  });

  // Fecha a lacuna de cobertura do filtro de erro gRPC (grpc-error.filter.ts)
  // para o codigo ALREADY_EXISTS: hoje nenhum teste do gateway exercita esse
  // branch. "cotar duas vezes" e invariante do bidding (constraint unique de
  // (loadId, carrierId), ver quote.entity.ts), nao validacao de forma do
  // gateway, entao o 409 so pode vir da traducao ALREADY_EXISTS->409 do
  // filtro.
  it("cotar duas vezes com a mesma transportadora devolve 409 (ALREADY_EXISTS)", async () => {
    const loadId = await publishLoad();
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send(validQuotePayload("carrier-duplicado"));

    const res = await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send(validQuotePayload("carrier-duplicado"));

    expect(res.status).toBe(409);
  });

  // Fecha a lacuna de cobertura do filtro de erro gRPC para o codigo
  // FAILED_PRECONDITION: aceitar sem ter cotado antes e o caso mais simples
  // desse branch (NoQuoteError do bidding, lancado antes de qualquer chamada
  // ao catalog).
  it("aceitar sem ter cotado devolve 409 (FAILED_PRECONDITION)", async () => {
    const loadId = await publishLoad();

    const res = await request(app.getHttpServer())
      .post(`/loads/${loadId}/accept`)
      .send({ carrierId: "carrier-sem-cotacao", idempotencyKey: "k1" });

    expect(res.status).toBe(409);
  });

  it("aceitar devolve 200 com a cotacao vencedora e a contagem de perdedoras", async () => {
    const loadId = await publishLoad();
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send({ carrierId: "c1", priceCents: 180000, etaHours: 30 });
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send({ carrierId: "c2", priceCents: 150000, etaHours: 20 });
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send({ carrierId: "c3", priceCents: 300000, etaHours: 40 });

    const res = await request(app.getHttpServer())
      .post(`/loads/${loadId}/accept`)
      .send({ carrierId: "c2", idempotencyKey: "k1" });

    expect(res.status).toBe(200);
    expect(res.body.winningQuote).toMatchObject({
      loadId, carrierId: "c2", priceCents: 150000, status: "won",
    });
    expect(res.body.losingQuotes).toBe(2);
  });

  it("GET /loads/:id/quotes lista as cotacoes da carga", async () => {
    const loadId = await publishLoad();
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send({ carrierId: "carrier-a", priceCents: 200000, etaHours: 24 });
    await request(app.getHttpServer())
      .post(`/loads/${loadId}/quotes`)
      .send({ carrierId: "carrier-b", priceCents: 100000, etaHours: 10 });

    const res = await request(app.getHttpServer()).get(`/loads/${loadId}/quotes`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect((res.body as { carrierId: string }[]).map((q) => q.carrierId).sort())
      .toEqual(["carrier-a", "carrier-b"]);
  });

  // loadId com formato uuid valido mas nunca publicado no catalog: o bidding
  // nao tem FK para o catalog (ver quote.accept.spec.ts, mesmo cenario), entao
  // SubmitQuote aceita a cotacao normalmente e so o AcceptLoad, ao chamar
  // ReserveLoad no catalog, descobre que a carga nao existe.
  it("aceitar carga inexistente devolve 404", async () => {
    const nonExistentLoadId = randomUUID();
    await request(app.getHttpServer())
      .post(`/loads/${nonExistentLoadId}/quotes`)
      .send(validQuotePayload("carrier-x"));

    const res = await request(app.getHttpServer())
      .post(`/loads/${nonExistentLoadId}/accept`)
      .send({ carrierId: "carrier-x", idempotencyKey: "k1" });

    expect(res.status).toBe(404);
  });
});
