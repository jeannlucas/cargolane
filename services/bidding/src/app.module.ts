import { Module, OnModuleDestroy } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Quote } from "./quote/quote.entity";
import { QuoteController } from "./quote/quote.controller";
import { QuoteRepository } from "./quote/quote.repository";
import { QuoteService } from "./quote/quote.service";

@Module({
  controllers: [QuoteController],
  providers: [
    {
      provide: DataSource,
      useFactory: async (): Promise<DataSource> => {
        const dataSource = new DataSource({
          type: "postgres",
          url: process.env.DATABASE_URL,
          entities: [Quote],
          // Divida deliberada com prazo, nao decisao de arquitetura: sem
          // migrations ate o Plano 4, o schema nasce do synchronize, igual ao
          // catalog. Nunca ligado em producao: synchronize:true em Postgres
          // altera/derruba coluna sem avisar.
          synchronize: process.env.NODE_ENV !== "production",
        });
        await dataSource.initialize();
        return dataSource;
      },
    },
    {
      provide: QuoteRepository,
      useFactory: (dataSource: DataSource) => new QuoteRepository(dataSource),
      inject: [DataSource],
    },
    QuoteService,
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
