import { status } from "@grpc/grpc-js";
import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { CatalogGrpcClient, startCatalogGrpcServer } from "./helpers/grpc";

describe("CatalogService gRPC", () => {
  let client: CatalogGrpcClient;
  let ds: DataSource;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const server = await startCatalogGrpcServer();
    client = server.client;
    ds = server.ds;
    stop = server.stop;
  }, 60_000);

  afterAll(async () => {
    await stop();
  });

  it("publica carga e devolve status open", async () => {
    const load = await client.publishLoad({
      shipper_id: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weight_kg: 12000,
      pickup_window_end: "2026-09-30T12:00:00Z",
      price_ceiling_cents: 350000,
    });

    expect(load.status).toBe("open");
    expect(load.id).toEqual(expect.any(String));
    expect(load.carrier_id).toBe("");
  });

  it("reservar carga ja reservada devolve FAILED_PRECONDITION", async () => {
    const load = await client.publishLoad({
      shipper_id: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weight_kg: 12000,
      pickup_window_end: "2026-09-30T12:00:00Z",
      price_ceiling_cents: 350000,
    });
    await client.reserveLoad({
      load_id: load.id, carrier_id: "carrier-a", idempotency_key: "k1",
    });

    await expect(client.reserveLoad({
      load_id: load.id, carrier_id: "carrier-b", idempotency_key: "k2",
    })).rejects.toMatchObject({ code: status.FAILED_PRECONDITION });
  });

  it("busca carga publicada por id e devolve os mesmos dados", async () => {
    const published = await client.publishLoad({
      shipper_id: "shipper-2",
      origin: "Londrina/PR",
      destination: "Sao Paulo/SP",
      weight_kg: 8000,
      pickup_window_end: "2026-10-01T09:00:00Z",
      price_ceiling_cents: 500000,
    });

    const found = await client.getLoad({ id: published.id });

    expect(found).toEqual(published);
  });

  it("buscar carga inexistente devolve NOT_FOUND", async () => {
    await expect(client.getLoad({
      id: "00000000-0000-0000-0000-000000000000",
    })).rejects.toMatchObject({ code: status.NOT_FOUND });
  });

  it("publicar carga com invariante invalida devolve INVALID_ARGUMENT, distinto de FAILED_PRECONDITION e NOT_FOUND", async () => {
    await expect(client.publishLoad({
      shipper_id: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weight_kg: 0,
      pickup_window_end: "2026-09-30T12:00:00Z",
      price_ceiling_cents: 350000,
    })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it("publicar carga com pickup_window_end ilegivel devolve INVALID_ARGUMENT, nao UNKNOWN", async () => {
    // pickup_window_end e string no .proto: "banana" e formalmente valido no
    // fio, nenhuma validacao de forma no gateway pegaria isso. new Date(
    // "banana").getTime() e NaN; sem a checagem de Number.isNaN em
    // LoadService.validate, isso chegava cru no INSERT e o Postgres devolvia
    // "invalid input syntax for type timestamp with time zone", que o Nest
    // traduzia para UNKNOWN com "Internal server error" - erro opaco e
    // vazamento de detalhe de infraestrutura.
    await expect(client.publishLoad({
      shipper_id: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weight_kg: 12000,
      pickup_window_end: "banana",
      price_ceiling_cents: 350000,
    })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it("reservar load_id inexistente devolve NOT_FOUND, distinto de carga ja reservada", async () => {
    await expect(client.reserveLoad({
      load_id: "00000000-0000-0000-0000-000000000000",
      carrier_id: "carrier-a",
      idempotency_key: "k1",
    })).rejects.toMatchObject({ code: status.NOT_FOUND });
  });

  it("lista cargas open da rota pedida, sem a que foi reservada", async () => {
    const origin = "Cascavel/PR";
    const destination = "Foz do Iguacu/PR";
    const open = await client.publishLoad({
      shipper_id: "shipper-3",
      origin,
      destination,
      weight_kg: 5000,
      pickup_window_end: "2026-11-01T09:00:00Z",
      price_ceiling_cents: 120000,
    });
    const toReserve = await client.publishLoad({
      shipper_id: "shipper-3",
      origin,
      destination,
      weight_kg: 5000,
      pickup_window_end: "2026-11-01T09:00:00Z",
      price_ceiling_cents: 120000,
    });
    await client.reserveLoad({
      load_id: toReserve.id, carrier_id: "carrier-a", idempotency_key: "k3",
    });

    const response = await client.listLoads({ origin, destination, limit: 10 });

    expect(response.loads).toHaveLength(1);
    expect(response.loads[0].id).toBe(open.id);
    expect(response.loads[0].status).toBe("open");
  });

  it("origin e destination vazios (o que o proto3 envia sem filtro) listam todas as cargas open", async () => {
    // origin: "" e destination: "" sao literalmente o que o proto-loader
    // poe no fio quando o cliente nao preenche esses campos de uma
    // ListLoadsRequest (proto3 nao distingue "ausente" de "string vazia").
    // Conta o que ja existia antes deste teste em vez de assumir uma base
    // zerada: os testes deste describe compartilham o mesmo Postgres.
    const alreadyOpen = await ds.getRepository(Load)
      .countBy({ status: LoadStatus.OPEN });

    const openA = await client.publishLoad({
      shipper_id: "shipper-4",
      origin: "Sem-Filtro-Grpc-A/PR",
      destination: "Sem-Filtro-Grpc-B/PR",
      weight_kg: 3000,
      pickup_window_end: "2026-11-05T09:00:00Z",
      price_ceiling_cents: 90000,
    });
    const toReserve = await client.publishLoad({
      shipper_id: "shipper-4",
      origin: "Sem-Filtro-Grpc-C/PR",
      destination: "Sem-Filtro-Grpc-D/PR",
      weight_kg: 3000,
      pickup_window_end: "2026-11-05T09:00:00Z",
      price_ceiling_cents: 90000,
    });
    await client.reserveLoad({
      load_id: toReserve.id,
      carrier_id: "carrier-sem-filtro",
      idempotency_key: "k-sem-filtro",
    });

    const response = await client.listLoads({
      origin: "", destination: "", limit: 1000,
    });

    // Se algum dia "origin || undefined" virar "origin !== undefined", este
    // teste falha: origin/destination vazios passariam a filtrar por
    // `origin = ''`, que nao bate com nenhuma rota real, e a lista viria
    // vazia em vez de trazer todas as cargas open (incluindo openA, cuja
    // rota nao e vazia).
    expect(response.loads).toHaveLength(alreadyOpen + 1);
    expect(response.loads.map((l) => l.id)).toContain(openA.id);
    expect(response.loads.map((l) => l.id)).not.toContain(toReserve.id);
  });
});
