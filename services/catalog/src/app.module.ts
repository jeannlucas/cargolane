import { Module, OnModuleDestroy } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { DataSource } from "typeorm";
import { Load } from "./load/load.entity";
import { LoadController } from "./load/load.controller";
import { LoadExpirationJob } from "./load/load.expiration.job";
import { LoadRepository } from "./load/load.repository";
import { LoadService } from "./load/load.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [LoadController],
  providers: [
    {
      provide: DataSource,
      useFactory: async (): Promise<DataSource> => {
        const dataSource = new DataSource({
          type: "postgres",
          url: process.env.DATABASE_URL,
          entities: [Load],
          // Divida deliberada com prazo, nao decisao de arquitetura: ainda
          // nao existem migrations, entao o schema nasce do synchronize,
          // igual aos testes de repositorio. Migrations e CI ainda vao
          // entrar. Ate la, nunca ligado em producao: synchronize:true em
          // Postgres altera/derruba coluna sem avisar, e um repositorio
          // publico nao pode expor isso como default de producao.
          synchronize: process.env.NODE_ENV !== "production",
        });
        await dataSource.initialize();
        return dataSource;
      },
    },
    {
      provide: LoadRepository,
      useFactory: (dataSource: DataSource) => new LoadRepository(dataSource),
      inject: [DataSource],
    },
    LoadService,
    LoadExpirationJob,
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleDestroy(): Promise<void> {
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
