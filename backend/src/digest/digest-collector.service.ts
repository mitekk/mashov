import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DigestBehaviorFact,
  DigestCandidate,
  DigestActivityFact,
  DigestGender,
  DigestHomeworkFact,
  DigestPayload,
  DigestReleaseFact,
} from './digest.types';

export interface DigestCollectInput {
  studentGuid: string;
  /** The candidates this run has claimed. Nothing outside them is reported. */
  candidates: DigestCandidate[];
  reportFor: Date;
  /**
   * The subscribing parent this payload is for. Needed for consent forms,
   * which are keyed by parent rather than by child, and required because the
   * run that asks is always one (child, user) pair.
   */
  userId: string;
}

/**
 * Turns claimed candidates into the payload the summarizer and the template
 * see.
 *
 * This is the PII boundary in data form: it reads the child's `privateName` and
 * nothing else identifying. `familyName`, `studentGuid`, `reporter` and
 * `rawPayload` are never selected, so they cannot reach a prompt by accident
 * later. See ADR-0026.
 */
@Injectable()
export class DigestCollectorService {
  constructor(private readonly prisma: PrismaService) {}

  async collect(input: DigestCollectInput): Promise<DigestPayload> {
    const { studentGuid, candidates, reportFor, userId } = input;

    const behaviorIds = idsOf(candidates, 'behavior');
    const newIds = idsOf(candidates, 'homework_new');
    const dueIds = idsOf(candidates, 'homework_due');

    const student = await this.prisma.student.findUnique({
      where: { studentGuid },
      select: { privateName: true, gender: true },
    });

    const releaseIds = idsOf(candidates, 'release').map((id) => Number(id));
    const activityIds = idsOf(candidates, 'activity').map((id) => Number(id));

    const behavior = behaviorIds.length > 0 ? await this.readBehavior(behaviorIds) : [];
    const releases = releaseIds.length > 0 ? await this.readReleases(studentGuid, releaseIds) : [];
    const activities =
      activityIds.length > 0 && userId ? await this.readActivities(userId, activityIds) : [];
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
      childGender: normalizeGender(student?.gender),
      reportFor,
      releases,
      activities,
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

  /**
   * Keyed by `releaseId`, Mashov's own id, because that is what the candidate
   * carries -- the checker hashes the upstream id, not our row's cuid.
   */
  private async readReleases(studentGuid: string, releaseIds: number[]): Promise<DigestReleaseFact[]> {
    const rows = await this.prisma.studentRelease.findMany({
      where: { studentGuid, releaseId: { in: releaseIds } },
      select: { releaseId: true, releaseDate: true, startHour: true, remark: true },
      orderBy: [{ releaseDate: 'asc' }, { startHour: 'asc' }],
    });

    return rows.map((row) => ({
      id: String(row.releaseId),
      releaseDate: row.releaseDate,
      startHour: row.startHour,
      remark: row.remark,
    }));
  }

  /**
   * The consent letter (`descriptionText`) is deliberately not selected. The
   * title and the deadline are the whole actionable content, and the letter
   * names staff and other children.
   */
  private async readActivities(userId: string, activityIds: number[]): Promise<DigestActivityFact[]> {
    const rows = await this.prisma.schoolActivity.findMany({
      // `endAnswerDate: { not: null }` keeps this read agreeing with
      // `DigestCheckerService`, whose `{ gte, lt }` filter excludes NULL by
      // construction (no SQL comparison is true against NULL). Since the column
      // became nullable an undated activity became reachable through this
      // re-read, and the parent would be reminded about a form with no deadline
      // — printed by `activitySentence` as a bare title. A deadline is what
      // makes an activity reportable, so the two reads must agree on it.
      //
      // Known residual, pre-existing and not this filter's business:
      // `activityId` is a per-school counter, so in a two-school household id
      // `1` matches both schools' rows. Closing that needs the connection and
      // year in the key here, which is its own change.
      where: { userId, activityId: { in: activityIds }, endAnswerDate: { not: null } },
      select: { activityId: true, title: true, activityStartDate: true, endAnswerDate: true },
      orderBy: { endAnswerDate: 'asc' },
    });

    return rows.map((row) => ({
      id: String(row.activityId),
      title: row.title,
      activityStartDate: row.activityStartDate,
      endAnswerDate: row.endAnswerDate,
    }));
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

/**
 * Mashov sends the child's gender as a single Hebrew letter on the login
 * response -- `ז` for male, `נ` for female (`apis/post-api-login.md:114`) --
 * and the column is a free-text `String`, so older or hand-seeded rows can
 * hold `M`/`F` instead. Anything unrecognised becomes null rather than a
 * guess: the prompt then says nothing about gender, which is better than
 * telling the model the wrong one and getting every verb wrong.
 */
export function normalizeGender(raw: string | null | undefined): DigestGender | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === 'ז' || value === 'm' || value === 'male') return 'male';
  if (value === 'נ' || value === 'f' || value === 'female') return 'female';
  return null;
}
