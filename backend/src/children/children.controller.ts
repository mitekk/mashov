import { Controller, Get, Put, Param, Query, Body } from '@nestjs/common';
import { IsInt, IsOptional, IsIn, IsBoolean, Min, Max } from 'class-validator';
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

class HomeworkQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived' = 'active';
}

class BehaviorQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['all', 'attention', 'positive', 'neutral'])
  bucket?: 'all' | 'attention' | 'positive' | 'neutral' = 'all';

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived' = 'active';
}

class SetIsNewDto {
  @IsBoolean()
  isNew!: boolean;
}

class SetArchivedDto {
  @IsBoolean()
  isArchived!: boolean;
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
    @Query() query: HomeworkQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const status = query.status ?? 'active';
    return this.childrenService.getHomework(studentGuid, page, limit, status);
  }

  @Get(':studentGuid/homework/:homeworkId')
  async getHomeworkDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
  ) {
    return this.childrenService.getHomeworkDetail(studentGuid, homeworkId);
  }

  @Put(':studentGuid/homework/:homeworkId/is-new')
  async setHomeworkIsNew(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Body() body: SetIsNewDto,
  ) {
    return this.childrenService.setHomeworkIsNew(studentGuid, homeworkId, body.isNew);
  }

  @Put(':studentGuid/homework/:homeworkId/archive')
  async setHomeworkArchived(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Body() body: SetArchivedDto,
  ) {
    return this.childrenService.setHomeworkArchived(studentGuid, homeworkId, body.isArchived);
  }

  @Get(':studentGuid/behavior')
  async getBehavior(
    @Param('studentGuid') studentGuid: string,
    @Query() query: BehaviorQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const bucket = query.bucket ?? 'all';
    const status = query.status ?? 'active';
    return this.childrenService.getBehavior(studentGuid, page, limit, bucket, status);
  }

  @Get(':studentGuid/behavior/:behaviorId')
  async getBehaviorDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
  ) {
    return this.childrenService.getBehaviorDetail(studentGuid, behaviorId);
  }

  @Put(':studentGuid/behavior/:behaviorId/is-new')
  async setBehaviorIsNew(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Body() body: SetIsNewDto,
  ) {
    return this.childrenService.setBehaviorIsNew(studentGuid, behaviorId, body.isNew);
  }

  @Put(':studentGuid/behavior/:behaviorId/archive')
  async setBehaviorArchived(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Body() body: SetArchivedDto,
  ) {
    return this.childrenService.setBehaviorArchived(studentGuid, behaviorId, body.isArchived);
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
