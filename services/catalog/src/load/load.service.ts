import { Injectable } from "@nestjs/common";
import { Load } from "./load.entity";
import { CreateLoadInput, ListLoadsFilter, LoadRepository } from "./load.repository";

@Injectable()
export class LoadService {
  constructor(private readonly loads: LoadRepository) {}

  publish(input: CreateLoadInput): Promise<Load> {
    return this.loads.create(input);
  }

  get(loadId: string): Promise<Load> {
    return this.loads.findById(loadId);
  }

  list(filter: ListLoadsFilter): Promise<Load[]> {
    return this.loads.list(filter);
  }

  reserve(loadId: string, carrierId: string): Promise<Load> {
    return this.loads.reserve(loadId, carrierId);
  }
}
