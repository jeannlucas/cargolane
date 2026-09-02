import {
  Column, CreateDateColumn, Entity, Index,
  PrimaryGeneratedColumn, VersionColumn,
} from "typeorm";

export enum LoadStatus {
  OPEN = "open",
  RESERVED = "reserved",
  PICKED_UP = "picked_up",
  IN_TRANSIT = "in_transit",
  DELIVERED = "delivered",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

@Entity("loads")
@Index(["origin", "destination"])
@Index(["status", "pickupWindowEnd"])
export class Load {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "shipper_id" })
  shipperId!: string;

  @Column()
  origin!: string;

  @Column()
  destination!: string;

  @Column({ name: "weight_kg", type: "int" })
  weightKg!: number;

  @Column({ name: "pickup_window_end", type: "timestamptz" })
  pickupWindowEnd!: Date;

  @Column({ name: "price_ceiling_cents", type: "int" })
  priceCeilingCents!: number;

  @Column({ type: "enum", enum: LoadStatus, default: LoadStatus.OPEN })
  status!: LoadStatus;

  @Column({ name: "carrier_id", type: "text", nullable: true })
  carrierId!: string | null;

  // Incrementada pelo UPDATE de reserve(), mas nao e ela quem protege a
  // reserva contra corrida: quem faz isso e o predicado `status = :open` no
  // WHERE de LoadRepository.reserve. Nao confiar na versao como mecanismo de
  // exclusividade.
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
