// @nestjs/schedule esta fixado em ^6.1.3 (ver package.json) porque a v12,
// que o `pnpm add` resolve por padrao, e ESM-only ("export * from
// './enums/index.js'" sem transpilar) e quebra o Jest com
// "SyntaxError: Unexpected token 'export'" ao carregar app.module.ts nos
// testes de integracao. A v12 tambem exige @nestjs/core/common ^11, e o
// projeto esta na v10 em todos os outros pacotes Nest. A v6.1.3 declara peer
// ^10.0.0 || ^11.0.0 e nao tem esse problema. Revisitar quando o projeto
// migrar para Nest v11.
import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { LoadRepository } from "./load.repository";

@Injectable()
export class LoadExpirationJob {
  private readonly log = new Logger(LoadExpirationJob.name);

  constructor(private readonly loads: LoadRepository) {}

  // try/catch obrigatorio aqui: uma promise rejeitada dentro de um handler de
  // @Interval vira unhandledRejection, e a partir do Node 22 isso encerra o
  // processo (achado I-3). Uma indisponibilidade momentanea do Postgres
  // derrubaria o servico inteiro, inclusive ReserveLoad, por causa de um job
  // secundario. Um tick que falha loga e aguarda o proximo, nunca propaga.
  @Interval(60_000)
  async run(): Promise<void> {
    try {
      const affected = await this.loads.expireOverdue(new Date());
      if (affected > 0) this.log.log(`expired ${affected} load(s)`);
    } catch (error) {
      this.log.error(
        "failed to expire overdue loads",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
