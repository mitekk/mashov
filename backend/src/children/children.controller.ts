import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ChildrenService } from './children.service';

class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

@Controller('children')
export class ChildrenController {
  constructor(private readonly childrenService: ChildrenService) {}

  @Get()
  async getChildren() {
    return this.childrenService.getChildren();
  }

  @Get(':studentGuid')
  async getChild(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getChildWorkspace(studentGuid);
  }

  @Get(':studentGuid/homework')
  async getHomework(
    @Param('studentGuid') studentGuid: string,
    @Query() query: PaginationQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.childrenService.getHomework(studentGuid, page, limit);
  }

  @Get(':studentGuid/behavior')
  async getBehavior(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getBehavior(studentGuid);
  }

  @Get(':studentGuid/subjects')
  async getSubjects(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getSubjects(studentGuid);
  }

  @Get(':studentGuid/notices')
  async getNotices(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getNotices(studentGuid);
  }
}
