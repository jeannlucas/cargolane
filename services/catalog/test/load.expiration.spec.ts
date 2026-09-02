import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { LoadRepository } from "../src/load/load.repository";
import { startPostgres } from "./helpers/pg";
import { makeSeed } from "./helpers/seed";

describe("LoadRepository.expireOverdue", () => {
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

  async function find(loadId: string): Promise<Load> {
    return ds.getRepository(Load).findOneByOrFail({ id: loadId });
  }

  it("expira apenas carga open com janela vencida", async () => {
    const vencida = await seed({ pickupWindowEnd: new Date("2026-01-01T00:00:00Z") });
    const futura = await seed({ pickupWindowEnd: new Date("2027-01-01T00:00:00Z") });
    const reservada = await seed({ pickupWindowEnd: new Date("2026-01-01T00:00:00Z") });
    await repo.reserve(reservada.id, "carrier-a");

    const affected = await repo.expireOverdue(new Date("2026-06-01T00:00:00Z"));

    expect(affected).toBe(1);
    expect((await find(vencida.id)).status).toBe(LoadStatus.EXPIRED);
    expect((await find(futura.id)).status).toBe(LoadStatus.OPEN);
    expect((await find(reservada.id)).status).toBe(LoadStatus.RESERVED);
  });
});
