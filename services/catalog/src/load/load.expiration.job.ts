import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { LoadRepository } from "./load.repository";

@Injectable()
export class LoadExpirationJob {
  private readonly log = new Logger(LoadExpirationJob.name);

  constructor(private readonly loads: LoadRepository) {}

  @Interval(60_000)
  async run(): Promise<void> {
    const affected = await this.loads.expireOverdue(new Date());
    if (affected > 0) this.log.log(`expired ${affected} load(s)`);
  }
}
