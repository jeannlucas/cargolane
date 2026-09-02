import { Module, OnModuleDestroy } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Load } from "./load/load.entity";
import { LoadController } from "./load/load.controller";
import { LoadRepository } from "./load/load.repository";
import { LoadService } from "./load/load.service";

@Module({
  controllers: [LoadController],
  providers: [
    {
      provide: DataSource,
      useFactory: async (): Promise<DataSource> => {
        const dataSource = new DataSource({
          type: "postgres",
          url: process.env.DATABASE_URL,
          entities: [Load],
          // Sem migrations neste servico: o schema nasce do synchronize,
          // igual aos testes de repositorio das tasks anteriores.
          synchronize: true,
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
