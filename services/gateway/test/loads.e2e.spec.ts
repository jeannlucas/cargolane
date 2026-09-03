import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApp } from "../src/create-app";
import { startCatalogForGatewayTests, TestCatalogServer } from "./helpers/catalog";

function validPayload() {
  return {
    shipperId: "shipper-1",
    origin: "Maringa/PR",
    destination: "Curitiba/PR",
    weightKg: 12000,
    pickupWindowEnd: "2026-12-31T12:00:00Z",
    priceCeilingCents: 350000,
  };
}

// Porta 1 e privilegiada: um processo sem root nunca consegue escutar nela,
// entao qualquer tentativa de discar para "127.0.0.1:1" falha na hora com
// connection refused. Usada (em vez de uma porta efemera "provavelmente
// livre") para garantir, sem nenhuma corrida, que nada esta ouvindo do outro
// lado.
//
// Pressuposto de plataforma: "porta < 1024 exige root para escutar" e
// convencao Unix (macOS/Linux, onde catalog/bidding/gateway rodam hoje), nao
// garantia do protocolo TCP em si — no Windows um processo sem privilegio
// pode escutar na porta 1 normalmente. Nao trocar por uma porta alta
// aleatoria "para ser mais portavel": isso reintroduziria a corrida de porta
// efemera (algo pode escutar la antes do teste rodar) e, pior, se algo
// responder do outro lado os testes de validationOnlyApp voltam a poder
// passar sem o ValidationPipe fazer nada — exatamente o mascaramento que a
// sabotagem desta task descobriu.
const UNREACHABLE_CATALOG_URL = "127.0.0.1:1";

describe("Gateway REST /loads", () => {
  let catalog: TestCatalogServer;
  let app: INestApplication;
  let validationOnlyApp: INestApplication;

  beforeAll(async () => {
    // CATALOG_GRPC_URL precisa estar definido ANTES de createApp(): e lido
    // dentro do useFactory do ClientsModule.registerAsync
    // (services/gateway/src/app.module.ts), chamado quando o Nest resolve o
    // provider no bootstrap — que acontece dentro deste createApp().
    catalog = await startCatalogForGatewayTests();
    app = await createApp();
    await app.init();

    // Segunda instancia da app, apontando para um endereco gRPC onde nada
    // esta escutando. Usada nos testes de validacao de forma (DTO/
    // ValidationPipe), para provar que a rejeicao 400 acontece no gateway,
    // sem depender do catalog estar no ar.
    //
    // Isso nao e paranoia: a primeira versao destes testes rodava contra o
    // catalog real e conferia so o status HTTP (e, no caso do peso negativo,
    // a contagem de linhas na tabela). Isso nao prova o que promete —
    // "shipperId" vazio e "weightKg" negativo TAMBEM sao invariantes que o
    // catalog rejeita por conta propria (ver load.service.ts:validate),
    // devolvendo o mesmo INVALID_ARGUMENT->400 pelo mesmo filtro. Um teste
    // assim passa igual mesmo se o ValidationPipe do gateway for removido
    // por inteiro — o que uma sabotagem real expos: ao tirar o
    // ValidationPipe, so o teste de "campo desconhecido" caiu (porque so
    // forbidNonWhitelisted nao tem equivalente no catalog); os demais
    // continuaram verdes escondidos atras da validacao do catalog. Rodar
    // estes quatro testes contra um catalog inalcancavel fecha essa lacuna:
    // um 400 aqui so pode ter vindo do gateway, porque nao ha ninguem do
    // outro lado para gerar qualquer resposta.
    const previousCatalogUrl = process.env.CATALOG_GRPC_URL;
    process.env.CATALOG_GRPC_URL = UNREACHABLE_CATALOG_URL;
    validationOnlyApp = await createApp();
    await validationOnlyApp.init();
    process.env.CATALOG_GRPC_URL = previousCatalogUrl;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await validationOnlyApp.close();
    await catalog.stop();
  });

  it("POST /loads sem shipperId devolve 400 dizendo o campo, sem depender do catalog", async () => {
    const res = await request(validationOnlyApp.getHttpServer())
      .post("/loads")
      .send({ ...validPayload(), shipperId: "" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("shipperId");
  });

  it("POST /loads com weightKg negativo devolve 400 sem depender do catalog", async () => {
    const res = await request(validationOnlyApp.getHttpServer())
      .post("/loads")
      .send({ ...validPayload(), weightKg: -100 });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("weightKg");
  });

  it("POST /loads com campo desconhecido no corpo devolve 400, sem depender do catalog", async () => {
    const res = await request(validationOnlyApp.getHttpServer())
      .post("/loads")
      .send({ ...validPayload(), unexpectedField: "nope" });

    expect(res.status).toBe(400);
  });

  it("POST /loads com pickupWindowEnd em data impossivel (rollover) devolve 400, sem depender do catalog", async () => {
    // "2027-02-30" nao existe: 2027 nao e bissexto e fevereiro tem no maximo
    // 28 dias. `new Date("2027-02-30T12:00:00Z")` nao lanca erro, so rola em
    // silencio para 2 de marco de 2027 — o achado que este teste fecha.
    //
    // Ano escolhido de proposito (2027, nao 2026): o rollover de
    // "2026-02-30" cai em 2 de marco de 2026, que already passou em relacao
    // a data real de hoje — o catalog rejeitaria essa data de qualquer jeito
    // pela invariante "pickupWindowEnd deve ser no futuro"
    // (load.service.ts), mascarando um IsRealIsoDateTime quebrado. Com 2027
    // o rollover cai no futuro, entao o catalog (se chegasse a ser chamado)
    // aceitaria essa data sem reclamar — o 400 so pode vir da checagem de
    // calendario do proprio gateway (src/loads/iso-date-time.validator.ts).
    // Rodar contra validationOnlyApp reforca a mesma garantia por um segundo
    // angulo: nem chega a discar para o catalog.
    const res = await request(validationOnlyApp.getHttpServer())
      .post("/loads")
      .send({ ...validPayload(), pickupWindowEnd: "2027-02-30T12:00:00Z" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("pickupWindowEnd");
  });

  it("GET /loads/:id malformado devolve 400, nao 500, sem depender do catalog", async () => {
    // Fecha o achado do Marco 1: id malformado, id bem formado mas
    // inexistente, e um erro de fato inesperado sao tres classes distintas
    // de erro que nao podem colapsar todas em "500 generico". Rodado contra
    // validationOnlyApp: ParseUUIDPipe rejeita antes de qualquer chamada ao
    // catalog, entao o 400 nao pode ter vindo de la.
    const res = await request(validationOnlyApp.getHttpServer()).get("/loads/not-a-valid-id");

    expect(res.status).toBe(400);
  });

  // Prova o fechamento do vazamento de infraestrutura no branch 500 do
  // filtro (grpc-error.filter.ts): um id bem formado passa pelo
  // ParseUUIDPipe e chega ao controller, que tenta discar GetLoad para
  // "127.0.0.1:1" (validationOnlyApp) — ninguem escuta la, entao o
  // @grpc/grpc-js rejeita com UNAVAILABLE, codigo fora do mapa do filtro. O
  // corpo da resposta precisa ser generico; o endereco/porta real do
  // catalog nunca pode aparecer nele, so no log do servidor.
  it("erro gRPC nao mapeado (catalog inalcancavel) devolve 500 generico, sem vazar endereco/porta interna", async () => {
    const res = await request(validationOnlyApp.getHttpServer()).get(`/loads/${randomUUID()}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: "internal server error" });

    const rawBody = JSON.stringify(res.body);
    expect(rawBody).not.toContain("ECONNREFUSED");
    expect(rawBody).not.toContain("127.0.0.1");
    expect(rawBody).not.toContain(UNREACHABLE_CATALOG_URL);
  });

  it("GET /loads/:id inexistente devolve 404", async () => {
    const res = await request(app.getHttpServer()).get(`/loads/${randomUUID()}`);

    expect(res.status).toBe(404);
  });

  // Precisa rodar antes de qualquer POST /loads bem-sucedido neste arquivo:
  // prova que uma lista vazia vinda do catalog (nenhuma linha na tabela)
  // chega ao REST como `[]`, nao como 500. O loader gRPC do catalog client
  // do gateway (services/gateway/src/app.module.ts) precisa de
  // `defaults: true` para isso: em proto3 um `repeated` vazio nao vem no
  // fio, e sem essa opcao o campo chega como `undefined`, e o `.map` em
  // LoadsController.list lanca TypeError.
  it("GET /loads sem nenhuma carga publicada devolve 200 com lista vazia", async () => {
    const res = await request(app.getHttpServer()).get("/loads");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /loads valido devolve 201 com o corpo da carga", async () => {
    const res = await request(app.getHttpServer()).post("/loads").send(validPayload());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      shipperId: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weightKg: 12000,
      priceCeilingCents: 350000,
      status: "open",
      carrierId: null,
    });
    expect(res.body.id).toEqual(expect.any(String));
  });

  // A rota GET /loads (sem filtro) nao tinha nenhum teste com resultado
  // nao vazio ate esta correcao — o teste acima so cobre a lista vazia.
  it("GET /loads devolve 200 com a carga publicada no teste anterior", async () => {
    const res = await request(app.getHttpServer()).get("/loads");

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body).toContainEqual(
      expect.objectContaining({
        origin: "Maringa/PR",
        destination: "Curitiba/PR",
        status: "open",
      }),
    );
  });

  it("GET /loads?origin=... sem nenhuma carga correspondente devolve 200 com lista vazia", async () => {
    const res = await request(app.getHttpServer())
      .get("/loads")
      .query({ origin: "Origem-que-nenhuma-carga-usa" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // Fecha a lacuna de cobertura do filtro de erro gRPC (grpc-error.filter.ts)
  // para o codigo INVALID_ARGUMENT: "origin igual a destino" e invariante de
  // dominio do catalog (nao validacao de forma do gateway), entao o 400 so
  // pode vir da traducao INVALID_ARGUMENT->400 do filtro, nunca do
  // ValidationPipe. Sabotar essa linha do filtro derruba este teste sem
  // afetar os testes de ValidationPipe acima. Precisa do catalog real (e por
  // isso roda em `app`, nao em `validationOnlyApp`): so o catalog decide essa
  // invariante.
  it("POST /loads com origin igual a destino devolve 400 via filtro (INVALID_ARGUMENT do catalog)", async () => {
    const res = await request(app.getHttpServer())
      .post("/loads")
      .send({ ...validPayload(), origin: "Maringa/PR", destination: "Maringa/PR" });

    expect(res.status).toBe(400);
  });
});
