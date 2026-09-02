import { DataSource } from "typeorm";
import { Quote, QuoteStatus } from "../src/quote/quote.entity";
import { startPostgres } from "./helpers/pg";

describe("Quote persistence", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;

  const LOAD = "load-1";

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres",
      url: pg.url,
      entities: [Quote],
      synchronize: true,
    });
    await ds.initialize();
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  it("nasce com status submitted", async () => {
    const repo = ds.getRepository(Quote);
    const saved = await repo.save(repo.create({
      loadId: LOAD,
      carrierId: "c1",
      priceCents: 1000,
      etaHours: 24,
    }));

    expect(saved.status).toBe(QuoteStatus.SUBMITTED);
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.createdAt).toBeInstanceOf(Date);
  });

  it("recusa duas cotacoes da mesma transportadora na mesma carga", async () => {
    const repo = ds.getRepository(Quote);
    await repo.save(repo.create({
      loadId: LOAD, carrierId: "c2", priceCents: 1000, etaHours: 24,
    }));
    await expect(
      repo.save(repo.create({
        loadId: LOAD, carrierId: "c2", priceCents: 900, etaHours: 20,
      })),
    ).rejects.toThrow();
  });

  it("permite a mesma transportadora cotar cargas diferentes", async () => {
    const repo = ds.getRepository(Quote);
    await repo.save(repo.create({
      loadId: "load-2", carrierId: "c3", priceCents: 1000, etaHours: 24,
    }));
    await expect(
      repo.save(repo.create({
        loadId: "load-3", carrierId: "c3", priceCents: 1100, etaHours: 22,
      })),
    ).resolves.toBeDefined();
  });
});
