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
      // poolSize alto o bastante para as 50 chamadas concorrentes do teste
      // abaixo abrirem sessao propria no Postgres. Com o default do pg-pool
      // (10), 40 das 50 chamadas esperam na fila do pool e a corrida vira
      // sequencial sem que o teste perceba.
      poolSize: 50,
    });
    await ds.initialize();
    repo = new LoadRepository(ds);
  }, 60_000);

  // Abre as 50 conexoes do pool antes da corrida. Sem isso, o pg-pool cria
  // conexoes sob demanda: as primeiras chamadas de reserve() pagam o custo de
  // handshake TCP e ficam para tras, o que serializa a corrida sozinho.
  async function warmPool(size: number): Promise<void> {
    await Promise.all(
      Array.from({ length: size }, () => ds.query("SELECT 1")),
    );
  }

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
    await warmPool(50);

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
