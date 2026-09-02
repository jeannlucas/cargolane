import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { LoadRepository } from "../src/load/load.repository";
import { LoadNotOpenError } from "../src/load/load.errors";
import { startPostgres } from "./helpers/pg";

describe("ReserveLoad sob concorrencia", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;
  let repo: LoadRepository;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres", url: pg.url, entities: [Load], synchronize: true,
    });
    await ds.initialize();
    repo = new LoadRepository(ds);
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  async function openLoad(): Promise<Load> {
    return ds.getRepository(Load).save(ds.getRepository(Load).create({
      shipperId: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weightKg: 12000,
      pickupWindowEnd: new Date("2026-09-30T12:00:00Z"),
      priceCeilingCents: 350000,
    }));
  }

  it("exatamente uma transportadora ganha entre 50 simultaneas", async () => {
    const load = await openLoad();
    const carriers = Array.from({ length: 50 }, (_, i) => `carrier-${i}`);

    const results = await Promise.allSettled(
      carriers.map((c) => repo.reserve(load.id, c)),
    );

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(49);
    for (const l of losers) {
      expect((l as PromiseRejectedResult).reason)
        .toBeInstanceOf(LoadNotOpenError);
    }

    const stored = await ds.getRepository(Load).findOneByOrFail({ id: load.id });
    expect(stored.status).toBe(LoadStatus.RESERVED);
    expect(carriers).toContain(stored.carrierId);
  });

  it("reservar carga ja reservada falha com LoadNotOpenError", async () => {
    const load = await openLoad();
    await repo.reserve(load.id, "carrier-a");

    await expect(repo.reserve(load.id, "carrier-b"))
      .rejects.toBeInstanceOf(LoadNotOpenError);

    const stored = await ds.getRepository(Load).findOneByOrFail({ id: load.id });
    expect(stored.carrierId).toBe("carrier-a");
  });
});
