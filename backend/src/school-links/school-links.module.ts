import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SchoolLinksController } from './school-links.controller';
import { SchoolLinksService } from './school-links.service';

@Module({
  imports: [PrismaModule],
  controllers: [SchoolLinksController],
  providers: [SchoolLinksService],
  exports: [SchoolLinksService],
})
export class SchoolLinksModule {}
