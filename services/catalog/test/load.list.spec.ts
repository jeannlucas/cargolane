import { DataSource } from "typeorm";
import { Load, LoadStatus } from "../src/load/load.entity";
import { LoadRepository } from "../src/load/load.repository";
import { LoadService } from "../src/load/load.service";
import { startPostgres } from "./helpers/pg";
import { makeSeed } from "./helpers/seed";

describe("LoadRepository.list", () => {
  let ds: DataSource;
  let stop: () => Promise<void>;
  let repo: LoadRepository;
  let service: LoadService;
  let seed: ReturnType<typeof makeSeed>;

  beforeAll(async () => {
    const pg = await startPostgres();
    stop = pg.stop;
    ds = new DataSource({
      type: "postgres", url: pg.url, entities: [Load], synchronize: true,
    });
    await ds.initialize();
    repo = new LoadRepository(ds);
    service = new LoadService(repo);
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

  it("sem filtro de origem/destino, lista todas as cargas open", async () => {
    // Conta o que ja existia antes deste teste em vez de assumir uma base
    // zerada: os testes deste arquivo compartilham a mesma conexao/banco
    // (setup em beforeAll), entao testes anteriores ja deixaram cargas open
    // na tabela. Comparar contra essa contagem em vez de um numero fixo
    // mantem a asserção exata mesmo se a ordem dos testes mudar.
    const alreadyOpen = await ds.getRepository(Load)
      .countBy({ status: LoadStatus.OPEN });

    await seed({ origin: "Sem-Filtro-A/PR", destination: "Sem-Filtro-B/PR" });
    await seed({ origin: "Sem-Filtro-C/PR", destination: "Sem-Filtro-D/PR" });
    const reserved = await seed({
      origin: "Sem-Filtro-E/PR", destination: "Sem-Filtro-F/PR",
    });
    await repo.reserve(reserved.id, "carrier-sem-filtro");

    const found = await repo.list({ limit: 1000 });

    expect(found).toHaveLength(alreadyOpen + 2);
  });

  // Normalizar o limit e regra de negocio de LoadService.list, nao acesso a
  // dados: LoadRepository.list hoje aplica o LIMIT recebido sem clamp (ver
  // Task 1). Por isso os dois testes abaixo passam pelo service, nao pelo
  // repositorio direto — testar o clamp contra repo.list estaria exercitando
  // a camada errada.
  it("normaliza limit fora do intervalo [1, 100] e trunca fracoes", async () => {
    const origin = "Curitiba/PR";
    const destination = "Joinville/SC";
    await seed({ origin, destination });
    await seed({ origin, destination });

    const zero = await service.list({ origin, destination, limit: 0 });
    const negative = await service.list({ origin, destination, limit: -5 });
    const fractional = await service.list({ origin, destination, limit: 1.5 });

    // limit: 0 cai no default de 20 -> as 2 cargas open da rota cabem inteiras.
    expect(zero).toHaveLength(2);
    // limit: -5 e sujeito a Math.max(..., 1) -> so a mais recente volta.
    expect(negative).toHaveLength(1);
    // limit: 1.5 e sujeito a Math.floor -> vira 1, nao 2 (Postgres aceita
    // LIMIT fracionario e arredondaria em silencio sem o floor).
    expect(fractional).toHaveLength(1);
  });

  it("aplica teto de 100 mesmo quando o limit pedido e maior", async () => {
    const origin = "Teto-Origem/PR";
    const destination = "Teto-Destino/PR";
    const repository = ds.getRepository(Load);
    // Insercao em lote (101 linhas): mais rapido que 101 chamadas
    // sequenciais a seed()/save(), e ainda passa pelo mesmo caminho de
    // persistencia (defaults de status/version/created_at aplicados pelo
    // TypeORM), diferente de um INSERT cru via query builder.
    await repository.save(
      repository.create(
        Array.from({ length: 101 }, () => ({
          shipperId: "shipper-1",
          origin,
          destination,
          weightKg: 12000,
          pickupWindowEnd: new Date("2026-09-30T12:00:00Z"),
          priceCeilingCents: 350000,
        })),
      ),
    );

    const found = await service.list({ origin, destination, limit: 500 });

    // Sem o teto (Math.min(..., 100)), esta asserção falha: das 101 cargas
    // open semeadas acima, viriam todas as 101, nao 100.
    expect(found).toHaveLength(100);
  }, 30_000);
});
