import { DataSource } from "typeorm";
import { Load } from "../../src/load/load.entity";

export function makeSeed(ds: DataSource) {
  return function seed(overrides: Partial<Load> = {}): Promise<Load> {
    const repo = ds.getRepository(Load);
    return repo.save(repo.create({
      shipperId: "shipper-1",
      origin: "Maringa/PR",
      destination: "Curitiba/PR",
      weightKg: 12000,
      pickupWindowEnd: new Date("2026-09-30T12:00:00Z"),
      priceCeilingCents: 350000,
      ...overrides,
    }));
  };
}
