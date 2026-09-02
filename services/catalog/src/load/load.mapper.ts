import { Load } from "./load.entity";

export interface LoadMessage {
  id: string;
  shipper_id: string;
  origin: string;
  destination: string;
  weight_kg: number;
  pickup_window_end: string;
  price_ceiling_cents: number;
  status: string;
  carrier_id: string;
}

// proto3 nao tem null: carrierId ausente (LoadStatus.OPEN, ninguem reservou
// ainda) vira string vazia na mensagem. O cliente distingue "sem
// transportadora" checando carrier_id === "" em vez de null/undefined.
export function toLoadMessage(load: Load): LoadMessage {
  return {
    id: load.id,
    shipper_id: load.shipperId,
    origin: load.origin,
    destination: load.destination,
    weight_kg: load.weightKg,
    pickup_window_end: load.pickupWindowEnd.toISOString(),
    price_ceiling_cents: load.priceCeilingCents,
    status: load.status,
    carrier_id: load.carrierId ?? "",
  };
}
