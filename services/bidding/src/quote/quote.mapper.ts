import { Quote } from "./quote.entity";

export interface QuoteMessage {
  id: string;
  load_id: string;
  carrier_id: string;
  price_cents: number;
  eta_hours: number;
  status: string;
}

export function toQuoteMessage(quote: Quote): QuoteMessage {
  return {
    id: quote.id,
    load_id: quote.loadId,
    carrier_id: quote.carrierId,
    price_cents: quote.priceCents,
    eta_hours: quote.etaHours,
    status: quote.status,
  };
}
