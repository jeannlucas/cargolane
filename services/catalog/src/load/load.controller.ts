import { status } from "@grpc/grpc-js";
import { Controller } from "@nestjs/common";
import { GrpcMethod, RpcException } from "@nestjs/microservices";
import { LoadNotFoundError, LoadNotOpenError } from "./load.errors";
import { LoadMessage, toLoadMessage } from "./load.mapper";
import { LoadService } from "./load.service";

interface PublishLoadRequest {
  shipper_id: string;
  origin: string;
  destination: string;
  weight_kg: number;
  pickup_window_end: string;
  price_ceiling_cents: number;
}

interface GetLoadRequest {
  id: string;
}

interface ReserveLoadRequest {
  load_id: string;
  carrier_id: string;
  idempotency_key: string;
}

@Controller()
export class LoadController {
  constructor(private readonly loads: LoadService) {}

  @GrpcMethod("CatalogService", "PublishLoad")
  async publishLoad(req: PublishLoadRequest): Promise<LoadMessage> {
    const load = await this.loads.publish({
      shipperId: req.shipper_id,
      origin: req.origin,
      destination: req.destination,
      weightKg: req.weight_kg,
      pickupWindowEnd: new Date(req.pickup_window_end),
      priceCeilingCents: req.price_ceiling_cents,
    });
    return toLoadMessage(load);
  }

  @GrpcMethod("CatalogService", "GetLoad")
  async getLoad(req: GetLoadRequest): Promise<LoadMessage> {
    try {
      return toLoadMessage(await this.loads.get(req.id));
    } catch (e) {
      if (e instanceof LoadNotFoundError) {
        throw new RpcException({ code: status.NOT_FOUND, message: e.message });
      }
      throw e;
    }
  }

  @GrpcMethod("CatalogService", "ReserveLoad")
  async reserveLoad(req: ReserveLoadRequest): Promise<LoadMessage> {
    try {
      return toLoadMessage(
        await this.loads.reserve(req.load_id, req.carrier_id),
      );
    } catch (e) {
      if (e instanceof LoadNotOpenError) {
        throw new RpcException({
          code: status.FAILED_PRECONDITION, message: e.message,
        });
      }
      if (e instanceof LoadNotFoundError) {
        throw new RpcException({ code: status.NOT_FOUND, message: e.message });
      }
      throw e;
    }
  }
}
