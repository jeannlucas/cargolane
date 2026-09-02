import {
  Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique,
} from "typeorm";

export enum QuoteStatus {
  SUBMITTED = "submitted",
  WON = "won",
  LOST = "lost",
}

// Unicidade de (loadId, carrierId) garantida por constraint do Postgres, nao
// por checagem na aplicacao: uma transportadora cota uma vez por carga, e e
// o banco quem recusa a segunda tentativa (mesma logica do UPDATE
// condicional de LoadRepository.reserve no Marco 1 — deixar o banco garantir
// o que ele ja sabe garantir).
@Entity("quotes")
@Unique(["loadId", "carrierId"])
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
