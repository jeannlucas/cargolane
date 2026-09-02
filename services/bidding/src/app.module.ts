import { Module, OnModuleDestroy } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CatalogClient } from "./quote/catalog.client";
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
    {
      provide: CatalogClient,
      // CATALOG_GRPC_URL: mesma variavel que o catalog usa para decidir onde
      // escutar (ver services/catalog/src/main.ts) — aqui o bidding a le
      // para saber onde discar. Default 127.0.0.1:50051 casa com o default
      // de escuta do catalog em producao/desenvolvimento local.
      useFactory: () => new CatalogClient(process.env.CATALOG_GRPC_URL ?? "127.0.0.1:50051"),
    },
    QuoteService,
  ],
})
export class AppModule implements OnModuleDestroy {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalogClient: CatalogClient,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.catalogClient.close();
    if (this.dataSource.isInitialized) {
      await this.dataSource.destroy();
    }
  }
}
