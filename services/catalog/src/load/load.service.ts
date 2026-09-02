import { Injectable } from "@nestjs/common";
import { Load } from "./load.entity";
import { CreateLoadInput, LoadRepository } from "./load.repository";

@Injectable()
export class LoadService {
  constructor(private readonly loads: LoadRepository) {}

  publish(input: CreateLoadInput): Promise<Load> {
    return this.loads.create(input);
  }

  get(loadId: string): Promise<Load> {
    return this.loads.findById(loadId);
  }

  reserve(loadId: string, carrierId: string): Promise<Load> {
    return this.loads.reserve(loadId, carrierId);
  }
}
