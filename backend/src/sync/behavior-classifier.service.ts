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

  async isJustifiable(achvaCode: number): Promise<boolean> {
    try {
      const ref = await this.prisma.behaviorTypeReference.findUnique({
        where: { code: achvaCode },
      });
      return ref?.justifiable ?? false;
    } catch {
      return false;
    }
  }

  classifyAll(eventCodes: number[]): BehaviorClassification[] {
    return eventCodes.map((code) => this.classify(code));
  }
}
