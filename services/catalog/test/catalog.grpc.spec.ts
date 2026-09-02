import { status } from "@grpc/grpc-js";
import { CatalogGrpcClient, startCatalogGrpcServer } from "./helpers/grpc";

describe("CatalogService gRPC", () => {
  let client: CatalogGrpcClient;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const server = await startCatalogGrpcServer();
    client = server.client;
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
});
