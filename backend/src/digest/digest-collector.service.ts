import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DigestBehaviorFact,
  DigestCandidate,
  DigestHomeworkFact,
  DigestPayload,
} from './digest.types';

export interface DigestCollectInput {
  studentGuid: string;
  /** The candidates this run has claimed. Nothing outside them is reported. */
  candidates: DigestCandidate[];
  reportFor: Date;
}

/**
 * Turns claimed candidates into the payload the summarizer and the template
 * see.
 *
 * This is the PII boundary in data form: it reads the child's `privateName` and
 * nothing else identifying. `familyName`, `studentGuid`, `reporter` and
 * `rawPayload` are never selected, so they cannot reach a prompt by accident
 * later. See ADR-0025.
 */
@Injectable()
export class DigestCollectorService {
  constructor(private readonly prisma: PrismaService) {}

  async collect(input: DigestCollectInput): Promise<DigestPayload> {
    const { studentGuid, candidates, reportFor } = input;

    const behaviorIds = idsOf(candidates, 'behavior');
    const newIds = idsOf(candidates, 'homework_new');
    const dueIds = idsOf(candidates, 'homework_due');

    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
      select: { privateName: true },
    });

    const behavior = behaviorIds.length > 0 ? await this.readBehavior(behaviorIds) : [];
    // One query for both homework sections: the same row can legitimately appear
    // in each, once as newly assigned and once as estimated-due.
    const homeworkIds = unique([...newIds, ...dueIds]);
    const homework = homeworkIds.length > 0 ? await this.readHomework(homeworkIds) : [];
    const homeworkById = new Map(homework.map((item) => [item.id, item]));

    const estimateByItemId = new Map(
      candidates
        .filter((candidate) => candidate.itemType === 'homework_due')
        .map((candidate) => [candidate.itemId, candidate.estimatedDueDate ?? null]),
    );

    return {
      childFirstName: student?.privateName ?? '',
      reportFor,
      behavior,
      homeworkNew: newIds
        .map((id) => homeworkById.get(id))
        .filter((item): item is DigestHomeworkFact => item !== undefined),
      homeworkDueTomorrow: dueIds
        .map((id) => homeworkById.get(id))
        .filter((item): item is DigestHomeworkFact => item !== undefined)
        .map((item) => ({ ...item, estimatedDueDate: estimateByItemId.get(item.id) ?? null })),
    };
  }

  private async readBehavior(ids: string[]): Promise<DigestBehaviorFact[]> {
    return (await this.prisma.behaviorItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        achvaName: true,
        classification: true,
        justifiable: true,
        subject: true,
        remark: true,
        lessonDate: true,
        eventAt: true,
      },
      orderBy: { eventAt: 'asc' },
    })) as DigestBehaviorFact[];
  }

  private async readHomework(ids: string[]): Promise<DigestHomeworkFact[]> {
    return (await this.prisma.homeworkItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        groupId: true,
        subjectName: true,
        homeworkText: true,
        remark: true,
        lessonDate: true,
      },
      orderBy: { lessonDate: 'asc' },
    })) as DigestHomeworkFact[];
  }
}

function idsOf(candidates: DigestCandidate[], itemType: DigestCandidate['itemType']): string[] {
  return unique(
    candidates.filter((candidate) => candidate.itemType === itemType).map((c) => c.itemId),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
