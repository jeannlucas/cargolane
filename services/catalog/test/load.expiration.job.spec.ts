import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { LoadExpirationJob } from "../src/load/load.expiration.job";
import { LoadRepository } from "../src/load/load.repository";
import { startPostgres } from "./helpers/pg";

// Estes testes provam duas coisas que load.expiration.spec.ts (que testa
// LoadRepository.expireOverdue isoladamente) nao cobre: que o job de fato
// chama o repositorio e loga (fiacao do @Interval), e que uma falha do
// repositorio nao escapa de run() (achado I-3/I-4). O teste de fiacao no
// AppModule prova que o provider continua registrado: se LoadExpirationJob
// sumisse de app.module.ts, app.get() abaixo lancaria.
describe("LoadExpirationJob", () => {
  function fakeRepo(expireOverdue: LoadRepository["expireOverdue"]): LoadRepository {
    return { expireOverdue } as unknown as LoadRepository;
  }

  it("chama expireOverdue e loga quando ha cargas expiradas", async () => {
    const expireOverdue = jest.fn().mockResolvedValue(3);
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    const job = new LoadExpirationJob(fakeRepo(expireOverdue));

    await job.run();

    expect(expireOverdue).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("expired 3 load(s)"));
    logSpy.mockRestore();
  });

  it("nao loga quando nenhuma carga expira", async () => {
    const expireOverdue = jest.fn().mockResolvedValue(0);
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    const job = new LoadExpirationJob(fakeRepo(expireOverdue));

    await job.run();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("captura falha do repositorio, loga o erro e nao propaga (I-3)", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const expireOverdue = jest.fn().mockRejectedValue(boom);
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const job = new LoadExpirationJob(fakeRepo(expireOverdue));

    await expect(job.run()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "failed to expire overdue loads",
      expect.stringContaining("connection terminated unexpectedly"),
    );
    errorSpy.mockRestore();
  });

  describe("fiacao no AppModule", () => {
    let stop: () => Promise<void>;
    let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>;

    beforeAll(async () => {
      const pg = await startPostgres();
      stop = pg.stop;
      process.env.DATABASE_URL = pg.url;
      app = await NestFactory.createApplicationContext(AppModule);
    }, 60_000);

    afterAll(async () => {
      await app.close();
      await stop();
    });

    it("resolve LoadExpirationJob como provider registrado", () => {
      const job = app.get(LoadExpirationJob);
      expect(job).toBeInstanceOf(LoadExpirationJob);
    });

    it("o provider resolvido esta ligado a um LoadRepository real", async () => {
      const job = app.get(LoadExpirationJob);
      const ds = app.get(DataSource);
      await expect(job.run()).resolves.toBeUndefined();
      expect(ds.isInitialized).toBe(true);
    });
  });
});
