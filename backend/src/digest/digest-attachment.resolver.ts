import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { extractBehaviorFiles, parseAttachmentList } from '../children/attachment-parser';
import { DigestCandidate } from './digest.types';

/** One attachment on a claimed item, with what the downloader needs to find it. */
export interface DigestAttachment {
  itemType: 'homework' | 'behavior';
  itemId: string;
  studentGuid: string;
  fileId: string;
  fileName: string;
}

/**
 * Finds the files on the items a run has claimed.
 *
 * A class of its own rather than two more fields on `DigestPayload`, and that
 * is the whole point. `DigestPayload` feeds `buildPrompt`, which is the PII
 * boundary (ADR-0026) -- and a behaviour row's `rawPayload` carries the
 * reporter's name, the child's guid and the raw remark, none of which may
 * leave the host. `digest-collector.service.spec.ts` asserts the behaviour
 * read selects no `rawPayload` precisely so that cannot creep back.
 *
 * So the attachment metadata takes a separate path: two narrow reads of their
 * own, selecting the id column and the attachment column and nothing else,
 * never touching the summarizer or the template.
 *
 * It reuses the shared attachment parser rather than its own: behaviour
 * attachments live in `rawPayload` because `behavior_item` has no `files`
 * column, and that fact already has one reader.
 */
@Injectable()
export class DigestAttachmentResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    studentGuid: string,
    candidates: DigestCandidate[],
  ): Promise<DigestAttachment[]> {
    // One homework row can be claimed twice -- once as newly assigned, once as
    // estimated-due -- so the ids are deduped before the read.
    const homeworkIds = idsOf(candidates, ['homework_new', 'homework_due']);
    const behaviorIds = idsOf(candidates, ['behavior']);

    const attachments: DigestAttachment[] = [];

    if (homeworkIds.length > 0) {
      const rows = await this.prisma.homeworkItem.findMany({
        where: { studentGuid, id: { in: homeworkIds } },
        select: { id: true, files: true },
      });
      for (const row of rows) {
        for (const file of parseAttachmentList(row.files)) {
          attachments.push({
            itemType: 'homework',
            itemId: row.id,
            studentGuid,
            fileId: file.fileId,
            fileName: file.fileName,
          });
        }
      }
    }

    if (behaviorIds.length > 0) {
      const rows = await this.prisma.behaviorItem.findMany({
        where: { studentGuid, id: { in: behaviorIds } },
        select: { id: true, rawPayload: true, lessonId: true },
      });
      for (const row of rows) {
        for (const file of extractBehaviorFiles(row.rawPayload, row.lessonId)) {
          attachments.push({
            itemType: 'behavior',
            itemId: row.id,
            studentGuid,
            fileId: file.fileId,
            fileName: file.fileName,
          });
        }
      }
    }

    return attachments;
  }
}

function idsOf(candidates: DigestCandidate[], itemTypes: string[]): string[] {
  return [
    ...new Set(
      candidates
        .filter((candidate) => itemTypes.includes(candidate.itemType))
        .map((candidate) => candidate.itemId),
    ),
  ];
}
