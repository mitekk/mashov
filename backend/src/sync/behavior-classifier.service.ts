import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface BehaviorClassification {
  bucket: 'attention' | 'positive' | 'neutral';
  priority: 'high' | 'medium' | 'low';
}

// Default classification map from PRD FR-55
// Configurable in code, not hardcoded in UI
const DEFAULT_CLASSIFICATION_MAP: Map<number, BehaviorClassification> = new Map([
  [1, { bucket: 'attention', priority: 'medium' }],  // איחור
  [2, { bucket: 'attention', priority: 'high' }],    // חיסור
  [4, { bucket: 'positive', priority: 'low' }],      // חיזוק חיובי
  [5, { bucket: 'attention', priority: 'high' }],    // אי הכנת ש.ב.
  [6, { bucket: 'attention', priority: 'medium' }],  // אי הבאת ציוד
  [10, { bucket: 'attention', priority: 'medium' }], // לא השלים משימה בכיתה
  [11, { bucket: 'neutral', priority: 'low' }],      // חיסור בשל פעילות בית-ספרית
]);

const DEFAULT_CLASSIFICATION: BehaviorClassification = {
  bucket: 'neutral',
  priority: 'low',
};

@Injectable()
export class BehaviorClassifierService {
  constructor(private readonly prisma: PrismaService) {}

  classify(eventCode: number): BehaviorClassification {
    return DEFAULT_CLASSIFICATION_MAP.get(eventCode) ?? DEFAULT_CLASSIFICATION;
  }

  /**
   * Whether a school counts this behaviour code as excusing itself.
   *
   * Takes the school, because the taxonomy is school-local: the same code
   * means different things at different schools, and `justifiable` is each
   * school's own policy. Answering from the wrong school's row is how a
   * child's unexcused absence quietly becomes an excused one.
   *
   * Falls back to the code alone when the school has no row yet -- a
   * deployment whose achvas sync has not run for that school, or a row the
   * ownership migration left at schoolCode 0. False is the safe default: it
   * reports an absence as needing attention rather than silently excusing it.
   */
  async isJustifiable(schoolCode: number, achvaCode: number): Promise<boolean> {
    try {
      const scoped = await this.prisma.behaviorTypeReference.findUnique({
        where: { schoolCode_code: { schoolCode, code: achvaCode } },
      });
      if (scoped) return scoped.justifiable;

      const unscoped = await this.prisma.behaviorTypeReference.findFirst({
        where: { schoolCode: 0, code: achvaCode },
      });
      return unscoped?.justifiable ?? false;
    } catch {
      return false;
    }
  }

  classifyAll(eventCodes: number[]): BehaviorClassification[] {
    return eventCodes.map((code) => this.classify(code));
  }
}
