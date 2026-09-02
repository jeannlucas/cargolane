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
    // Casos degenerados: em JavaScript toda comparacao com NaN e false, entao
    // `weightKg <= 0`/`priceCeilingCents <= 0`/`getTime() <= Date.now()`
    // sozinhos deixam NaN e Infinity passarem direto para o INSERT. So
    // -Infinity e capturado pela comparacao simples (-Infinity <= 0 e true) —
    // por isso ele nao esta nesta lista, mas os outros tres estao, junto com
    // Infinity/NaN de priceCeilingCents e uma Date invalida.
    ["peso NaN", { weightKg: NaN }, "weightKg"],
    ["peso infinito", { weightKg: Infinity }, "weightKg"],
    ["preco NaN", { priceCeilingCents: NaN }, "priceCeilingCents"],
    ["preco infinito", { priceCeilingCents: Infinity }, "priceCeilingCents"],
    ["preco infinito negativo", { priceCeilingCents: -Infinity }, "priceCeilingCents"],
    ["janela invalida (Date de string ilegivel)", { pickupWindowEnd: new Date("banana") }, "pickupWindowEnd"],
  ])("rejeita %s", async (_label, override, field) => {
    await expect(service.publish({ ...base, ...override }))
      .rejects.toMatchObject({ name: "InvalidLoadError", field });
  });

  it("nao persiste nada quando a validacao falha", async () => {
    const before = await ds.getRepository(Load).count();
    await expect(service.publish({ ...base, weightKg: -1 })).rejects.toThrow();
    expect(await ds.getRepository(Load).count()).toBe(before);
  });

  it("nao persiste nada para os casos degenerados (NaN, Infinity, Date invalida)", async () => {
    const before = await ds.getRepository(Load).count();

    await expect(service.publish({ ...base, weightKg: NaN })).rejects.toThrow();
    await expect(service.publish({ ...base, weightKg: Infinity })).rejects.toThrow();
    await expect(service.publish({ ...base, priceCeilingCents: NaN })).rejects.toThrow();
    await expect(service.publish({ ...base, priceCeilingCents: Infinity })).rejects.toThrow();
    await expect(service.publish({ ...base, pickupWindowEnd: new Date("banana") }))
      .rejects.toThrow();

    expect(await ds.getRepository(Load).count()).toBe(before);
  });
});
