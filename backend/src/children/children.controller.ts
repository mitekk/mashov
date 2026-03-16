import { Controller, Get, Put, Param, Query, Body, Res, Req, StreamableFile } from '@nestjs/common';
import { IsInt, IsOptional, IsIn, IsBoolean, Min, Max, IsArray, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { ChildrenService } from './children.service';
import type { Request, Response } from 'express';

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
  @IsIn(['new', 'archived', 'all'])
  status?: 'new' | 'archived' | 'all' = 'new';
}

class BehaviorQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['all', 'attention', 'positive', 'neutral'])
  bucket?: 'all' | 'attention' | 'positive' | 'neutral' = 'all';

  @IsOptional()
  @IsIn(['new', 'archived', 'all'])
  status?: 'new' | 'archived' | 'all' = 'new';
}

class SetIsNewDto {
  @IsBoolean()
  isNew!: boolean;
}

class SetArchivedDto {
  @IsBoolean()
  isArchived!: boolean;
}

class BulkHomeworkIsNewDto {
  @IsArray()
  @IsString({ each: true })
  homeworkIds!: string[];

  @IsBoolean()
  isNew!: boolean;
}

class BulkHomeworkArchiveDto {
  @IsArray()
  @IsString({ each: true })
  homeworkIds!: string[];

  @IsBoolean()
  isArchived!: boolean;
}

class BulkBehaviorIsNewDto {
  @IsArray()
  @IsString({ each: true })
  behaviorIds!: string[];

  @IsBoolean()
  isNew!: boolean;
}

class BulkBehaviorArchiveDto {
  @IsArray()
  @IsString({ each: true })
  behaviorIds!: string[];

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
    @Req() req: Request,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const status = query.status ?? 'new';
    return this.childrenService.getHomework(studentGuid, page, limit, status, req.user?.userId);
  }

  @Get(':studentGuid/homework/:homeworkId')
  async getHomeworkDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Req() req: Request,
  ) {
    return this.childrenService.getHomeworkDetail(studentGuid, homeworkId, req.user?.userId);
  }

  @Get(':studentGuid/homework/:homeworkId/files/:fileId')
  async downloadHomeworkFile(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.childrenService.downloadHomeworkAttachment(
      studentGuid,
      homeworkId,
      fileId,
    );

    response.setHeader(
      'Content-Type',
      file.contentType ?? 'application/octet-stream',
    );
    response.setHeader(
      'Content-Disposition',
      file.contentDisposition
        ?? `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? fileId)}`,
    );

    return new StreamableFile(file.buffer);
  }

  @Put(':studentGuid/homework/:homeworkId/is-new')
  async setHomeworkIsNew(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Body() body: SetIsNewDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setHomeworkIsNew(studentGuid, homeworkId, body.isNew, req.user?.userId);
  }

  @Put(':studentGuid/homework/is-new')
  async setHomeworkManyIsNew(
    @Param('studentGuid') studentGuid: string,
    @Body() body: BulkHomeworkIsNewDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setHomeworkManyIsNew(
      studentGuid,
      body.homeworkIds,
      body.isNew,
      req.user?.userId,
    );
  }

  @Put(':studentGuid/homework/:homeworkId/archive')
  async setHomeworkArchived(
    @Param('studentGuid') studentGuid: string,
    @Param('homeworkId') homeworkId: string,
    @Body() body: SetArchivedDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setHomeworkArchived(studentGuid, homeworkId, body.isArchived, req.user?.userId);
  }

  @Put(':studentGuid/homework/archive')
  async setHomeworkManyArchived(
    @Param('studentGuid') studentGuid: string,
    @Body() body: BulkHomeworkArchiveDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setHomeworkManyArchived(
      studentGuid,
      body.homeworkIds,
      body.isArchived,
      req.user?.userId,
    );
  }

  @Get(':studentGuid/behavior')
  async getBehavior(
    @Param('studentGuid') studentGuid: string,
    @Query() query: BehaviorQueryDto,
    @Req() req: Request,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const bucket = query.bucket ?? 'all';
    const status = query.status ?? 'new';
    return this.childrenService.getBehavior(studentGuid, page, limit, bucket, status, req.user?.userId);
  }

  @Get(':studentGuid/behavior/:behaviorId')
  async getBehaviorDetail(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Req() req: Request,
  ) {
    return this.childrenService.getBehaviorDetail(studentGuid, behaviorId, req.user?.userId);
  }

  @Get(':studentGuid/behavior/:behaviorId/files/:fileId')
  async downloadBehaviorFile(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.childrenService.downloadBehaviorAttachment(
      studentGuid,
      behaviorId,
      fileId,
    );

    response.setHeader(
      'Content-Type',
      file.contentType ?? 'application/octet-stream',
    );
    response.setHeader(
      'Content-Disposition',
      file.contentDisposition
        ?? `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName ?? fileId)}`,
    );

    return new StreamableFile(file.buffer);
  }

  @Put(':studentGuid/behavior/:behaviorId/is-new')
  async setBehaviorIsNew(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Body() body: SetIsNewDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setBehaviorIsNew(studentGuid, behaviorId, body.isNew, req.user?.userId);
  }

  @Put(':studentGuid/behavior/is-new')
  async setBehaviorManyIsNew(
    @Param('studentGuid') studentGuid: string,
    @Body() body: BulkBehaviorIsNewDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setBehaviorManyIsNew(
      studentGuid,
      body.behaviorIds,
      body.isNew,
      req.user?.userId,
    );
  }

  @Put(':studentGuid/behavior/:behaviorId/archive')
  async setBehaviorArchived(
    @Param('studentGuid') studentGuid: string,
    @Param('behaviorId') behaviorId: string,
    @Body() body: SetArchivedDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setBehaviorArchived(studentGuid, behaviorId, body.isArchived, req.user?.userId);
  }

  @Put(':studentGuid/behavior/archive')
  async setBehaviorManyArchived(
    @Param('studentGuid') studentGuid: string,
    @Body() body: BulkBehaviorArchiveDto,
    @Req() req: Request,
  ) {
    return this.childrenService.setBehaviorManyArchived(
      studentGuid,
      body.behaviorIds,
      body.isArchived,
      req.user?.userId,
    );
  }

  @Get(':studentGuid/timetable')
  getTimetable(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getTimetable(studentGuid);
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
