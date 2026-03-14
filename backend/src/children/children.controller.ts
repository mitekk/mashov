import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsIn, Min, Max } from 'class-validator';
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

class BehaviorQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['all', 'attention', 'positive', 'neutral'])
  bucket?: 'all' | 'attention' | 'positive' | 'neutral' = 'all';
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

  @Get(':studentGuid/homework/:homeworkId')
  async getHomeworkDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
  ) {
    return this.childrenService.getHomeworkDetail(studentGuid, homeworkId);
  }

  @Get(':studentGuid/behavior')
  async getBehavior(
    @Param('studentGuid') studentGuid: string,
    @Query() query: BehaviorQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const bucket = query.bucket ?? 'all';
    return this.childrenService.getBehavior(studentGuid, page, limit, bucket);
  }

  @Get(':studentGuid/behavior/:behaviorId')
  async getBehaviorDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
  ) {
    return this.childrenService.getBehaviorDetail(studentGuid, behaviorId);
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
