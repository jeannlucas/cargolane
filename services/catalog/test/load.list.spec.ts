import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { LoadRepository } from "../src/load/load.repository";
import { startPostgres } from "./helpers/pg";
import { makeSeed } from "./helpers/seed";

describe("LoadRepository.list", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;
  let repo: LoadRepository;
  let seed: ReturnType<typeof makeSeed>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres", url: pg.url, entities: [Load], synchronize: true,
    });
    await ds.initialize();
    repo = new LoadRepository(ds);
    seed = makeSeed(ds);
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  it("lista apenas cargas open da rota pedida", async () => {
    await seed({ origin: "Maringa/PR", destination: "Curitiba/PR" });
    await seed({ origin: "Maringa/PR", destination: "Londrina/PR" });
    const reserved = await seed({ origin: "Maringa/PR", destination: "Curitiba/PR" });
    await repo.reserve(reserved.id, "carrier-a");

    const found = await repo.list({
      origin: "Maringa/PR", destination: "Curitiba/PR", limit: 10,
    });

    expect(found).toHaveLength(1);
    expect(found[0].status).toBe(LoadStatus.OPEN);
  });

  it("devolve mais recentes primeiro", async () => {
    const first = await seed({
      origin: "Sao Paulo/SP", destination: "Rio de Janeiro/RJ",
    });
    const second = await seed({
      origin: "Sao Paulo/SP", destination: "Rio de Janeiro/RJ",
    });

    const found = await repo.list({
      origin: "Sao Paulo/SP", destination: "Rio de Janeiro/RJ", limit: 10,
    });

    expect(found.map((l) => l.id)).toEqual([second.id, first.id]);
  });

  it("normaliza limit fora do intervalo [1, 100]", async () => {
    await seed({ origin: "Curitiba/PR", destination: "Joinville/SC" });

    const zero = await repo.list({
      origin: "Curitiba/PR", destination: "Joinville/SC", limit: 0,
    });
    const negative = await repo.list({
      origin: "Curitiba/PR", destination: "Joinville/SC", limit: -5,
    });

    expect(zero.length).toBeGreaterThan(0);
    expect(negative.length).toBeGreaterThan(0);
  });
});
