import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { startPostgres } from "./helpers/pg";

describe("Load persistence", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres",
      url: pg.url,
      entities: [Load],
      synchronize: true,
    });
    await ds.initialize();
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  it("nasce com status open e sem transportadora", async () => {
    const repo = ds.getRepository(Load);
    const saved = await repo.save(repo.create({
      shipperId: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weightKg: 12000,
      pickupWindowEnd: new Date("2026-09-30T12:00:00Z"),
      priceCeilingCents: 350000,
    }));

    expect(saved.status).toBe(LoadStatus.OPEN);
    expect(saved.carrierId).toBeNull();
    expect(saved.id).toEqual(expect.any(String));
  });
});
