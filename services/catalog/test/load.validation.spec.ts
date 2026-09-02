import { DataSource } from "typeorm";
import { Load } from "../src/load/load.entity";
import { LoadRepository } from "../src/load/load.repository";
import { LoadService } from "../src/load/load.service";
import { startPostgres } from "./helpers/pg";

describe("LoadService.publish valida invariantes", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;
  let service: LoadService;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres", url: pg.url, entities: [Load], synchronize: true,
    });
    await ds.initialize();
    service = new LoadService(new LoadRepository(ds));
  }, 60_000);

  afterAll(async () => {
    await ds.destroy();
    await stop();
  });

  const base = {
    shipperId: "shipper-1",
    origin: "Maringa/PR",
    destination: "Curitiba/PR",
    weightKg: 12000,
    pickupWindowEnd: new Date(Date.now() + 86_400_000),
    priceCeilingCents: 350_000,
  };

  it.each([
    ["shipperId", { shipperId: "  " }, "shipperId"],
    ["peso zero", { weightKg: 0 }, "weightKg"],
    ["peso negativo", { weightKg: -1 }, "weightKg"],
    ["preco zero", { priceCeilingCents: 0 }, "priceCeilingCents"],
    ["janela no passado", { pickupWindowEnd: new Date("2020-01-01") }, "pickupWindowEnd"],
    ["origem igual ao destino", { destination: "Maringa/PR" }, "destination"],
  ])("rejeita %s", async (_label, override, field) => {
    await expect(service.publish({ ...base, ...override }))
      .rejects.toMatchObject({ name: "InvalidLoadError", field });
  });

  it("nao persiste nada quando a validacao falha", async () => {
    const before = await ds.getRepository(Load).count();
    await expect(service.publish({ ...base, weightKg: -1 })).rejects.toThrow();
    expect(await ds.getRepository(Load).count()).toBe(before);
  });
});
