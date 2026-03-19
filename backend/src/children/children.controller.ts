import { Controller, Get, Put, Delete, Param, Query, Body, Res, Req, StreamableFile } from '@nestjs/common';
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
  status?: 'new' | 'archived' | 'all' = 'all';
}

class BehaviorQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['all', 'attention', 'positive', 'neutral'])
  bucket?: 'all' | 'attention' | 'positive' | 'neutral' = 'all';

  @IsOptional()
  @IsIn(['new', 'archived', 'all'])
  status?: 'new' | 'archived' | 'all' = 'all';
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

class UpdateReleaseDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  id?: number;

  @IsOptional()
  @IsString()
  studentGuid?: string;

  @IsOptional()
  @IsString()
  contactGuid?: string;

  @IsOptional()
  @IsString()
  releaseDate?: string;

  @IsOptional()
  @IsString()
  startHour?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;

  @IsOptional()
  @IsBoolean()
  isDeleted?: boolean;

  @IsOptional()
  @IsString()
  requestEditTime?: string;

  @IsOptional()
  @IsString()
  releaseDateMoment?: string;

  @IsOptional()
  @IsBoolean()
  isExpired?: boolean;

  @IsOptional()
  @IsBoolean()
  isDirty_menu?: boolean;
}

class CreateReleaseDto {
  @IsString()
  studentGuid!: string;

  @IsString()
  releaseDate!: string;

  @IsString()
  startHour!: string;

  @IsString()
  remark!: string;
}

@Controller('children')
export class ChildrenController {
  constructor(private readonly childrenService: ChildrenService) {}

  @Get()
  async getChildren(@Req() req: Request) {
    return this.childrenService.getChildren(req.user?.userId);
  }

  @Get(':studentGuid')
  async getChild(
    @Param('studentGuid') studentGuid: string,
    @Req() req: Request,
  ) {
    return this.childrenService.getChildWorkspace(studentGuid, req.user?.userId);
  }

  @Get(':studentGuid/homework')
  async getHomework(
    @Param('studentGuid') studentGuid: string,
    @Query() query: HomeworkQueryDto,
    @Req() req: Request,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const status = query.status ?? 'all';
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
    const status = query.status ?? 'all';
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

  @Get(':studentGuid/lessons/plans')
  getLessonPlans(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getLessonPlans(studentGuid);
  }

  @Get(':studentGuid/lessons/history')
  getLessonHistory(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getLessonHistory(studentGuid);
  }

  @Get(':studentGuid/releases')
  getStudentReleases(@Param('studentGuid') studentGuid: string) {
    return this.childrenService.getStudentReleases(studentGuid);
  }

  @Put(':studentGuid/releases/request')
  async createStudentRelease(
    @Param('studentGuid') studentGuid: string,
    @Body() body: CreateReleaseDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.status(204);
    await this.childrenService.createStudentRelease(
      studentGuid,
      { ...body, studentGuid },
    );
  }

  @Put(':studentGuid/releases/:releaseId')
  updateStudentRelease(
    @Param('studentGuid') studentGuid: string,
    @Param('releaseId') releaseId: string,
    @Body() body: UpdateReleaseDto,
  ) {
    return this.childrenService.updateStudentRelease(
      studentGuid,
      Number(releaseId),
      body,
    );
  }

  @Delete(':studentGuid/releases/:releaseId')
  deleteStudentRelease(
    @Param('studentGuid') studentGuid: string,
    @Param('releaseId') releaseId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.status(204);
    return this.childrenService.deleteStudentRelease(studentGuid, Number(releaseId));
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
