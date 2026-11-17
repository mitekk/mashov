import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withPoolSettings } from './prisma-pool';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = withPoolSettings(process.env.DATABASE_URL);
    // Only override the datasource when there is a URL to override it with --
    // passing `url: undefined` would stop Prisma falling back to the schema's
    // own `env("DATABASE_URL")`, which is what the test harness relies on.
    super(url ? { datasources: { db: { url } } } : {});
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
