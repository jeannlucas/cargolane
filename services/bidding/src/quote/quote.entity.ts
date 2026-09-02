import {
  Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique,
} from "typeorm";

export enum QuoteStatus {
  SUBMITTED = "submitted",
  WON = "won",
  LOST = "lost",
}

// Nome explicito da constraint (em vez do hash que o TypeORM geraria, tipo
// "UQ_c4ffd11b8d6667b347e41f5e1db"): QuoteRepository.submit precisa comparar
// o nome da constraint violada para nao confundir esta violacao com a de
// outra constraint unique que venha a existir na tabela (ex.: idempotency_key
// da Task 4). Um nome explicito sobrevive a mudanca de coluna e e legivel em
// log de producao; o hash gerado automaticamente nao.
export const QUOTE_LOAD_CARRIER_UNIQUE_CONSTRAINT = "UQ_quotes_load_id_carrier_id";

// Unicidade de (loadId, carrierId) garantida por constraint do Postgres, nao
// por checagem na aplicacao: uma transportadora cota uma vez por carga, e e
// o banco quem recusa a segunda tentativa (mesma logica do UPDATE
// condicional de LoadRepository.reserve no Marco 1 — deixar o banco garantir
// o que ele ja sabe garantir).
@Entity("quotes")
@Unique(QUOTE_LOAD_CARRIER_UNIQUE_CONSTRAINT, ["loadId", "carrierId"])
export class Quote {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "load_id" })
  loadId!: string;

  @Column({ name: "carrier_id" })
  carrierId!: string;

  @Column({ name: "price_cents", type: "int" })
  priceCents!: number;

  @Column({ name: "eta_hours", type: "int" })
  etaHours!: number;

  @Column({ type: "enum", enum: QuoteStatus, default: QuoteStatus.SUBMITTED })
  status!: QuoteStatus;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
