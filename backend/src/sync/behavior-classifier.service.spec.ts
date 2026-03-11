import { BehaviorClassifierService } from './behavior-classifier.service';
import { PrismaService } from '../prisma/prisma.service';

describe('BehaviorClassifierService', () => {
  let service: BehaviorClassifierService;
  let mockPrisma: jest.Mocked<Pick<PrismaService, 'behaviorTypeReference'>>;

  beforeEach(() => {
    mockPrisma = {
      behaviorTypeReference: {
        findUnique: jest.fn(),
      } as unknown as jest.Mocked<PrismaService['behaviorTypeReference']>,
    };
    service = new BehaviorClassifierService(mockPrisma as unknown as PrismaService);
  });

  describe('classify', () => {
    describe('attention bucket', () => {
      it('classifies eventCode 1 (late arrival) as attention/medium', () => {
        const result = service.classify(1);
        expect(result.bucket).toBe('attention');
        expect(result.priority).toBe('medium');
      });

      it('classifies eventCode 2 (absence) as attention/high', () => {
        const result = service.classify(2);
        expect(result.bucket).toBe('attention');
        expect(result.priority).toBe('high');
      });

      it('classifies eventCode 5 (homework not done) as attention/high', () => {
        const result = service.classify(5);
        expect(result.bucket).toBe('attention');
        expect(result.priority).toBe('high');
      });

      it('classifies eventCode 6 (missing equipment) as attention/medium', () => {
        const result = service.classify(6);
        expect(result.bucket).toBe('attention');
        expect(result.priority).toBe('medium');
      });

      it('classifies eventCode 10 (incomplete classroom task) as attention/medium', () => {
        const result = service.classify(10);
        expect(result.bucket).toBe('attention');
        expect(result.priority).toBe('medium');
      });
    });

    describe('positive bucket', () => {
      it('classifies eventCode 4 (positive reinforcement) as positive/low', () => {
        const result = service.classify(4);
        expect(result.bucket).toBe('positive');
        expect(result.priority).toBe('low');
      });
    });

    describe('neutral bucket', () => {
      it('classifies eventCode 11 (school activity absence) as neutral/low', () => {
        const result = service.classify(11);
        expect(result.bucket).toBe('neutral');
        expect(result.priority).toBe('low');
      });
    });

    describe('unknown event codes', () => {
      it('falls back to neutral/low for an unknown eventCode', () => {
        const result = service.classify(9999);
        expect(result.bucket).toBe('neutral');
        expect(result.priority).toBe('low');
      });

      it('falls back to neutral/low for eventCode 0', () => {
        const result = service.classify(0);
        expect(result.bucket).toBe('neutral');
        expect(result.priority).toBe('low');
      });

      it('falls back to neutral/low for a negative eventCode', () => {
        const result = service.classify(-1);
        expect(result.bucket).toBe('neutral');
        expect(result.priority).toBe('low');
      });

      it('falls back to neutral/low for eventCode 3 (not in map)', () => {
        const result = service.classify(3);
        expect(result.bucket).toBe('neutral');
        expect(result.priority).toBe('low');
      });
    });

    describe('priority mapping', () => {
      it('returns high priority for high-severity codes', () => {
        const high = [2, 5];
        for (const code of high) {
          expect(service.classify(code).priority).toBe('high');
        }
      });

      it('returns medium priority for moderate-severity codes', () => {
        const medium = [1, 6, 10];
        for (const code of medium) {
          expect(service.classify(code).priority).toBe('medium');
        }
      });

      it('returns low priority for low-severity codes', () => {
        const low = [4, 11];
        for (const code of low) {
          expect(service.classify(code).priority).toBe('low');
        }
      });
    });
  });

  describe('classifyAll', () => {
    it('classifies an array of event codes and returns matching classifications', () => {
      const results = service.classifyAll([1, 4, 9999]);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ bucket: 'attention', priority: 'medium' });
      expect(results[1]).toEqual({ bucket: 'positive', priority: 'low' });
      expect(results[2]).toEqual({ bucket: 'neutral', priority: 'low' });
    });

    it('returns an empty array when given an empty input', () => {
      const results = service.classifyAll([]);
      expect(results).toEqual([]);
    });
  });

  describe('isJustifiable', () => {
    it('returns true when the behavior type reference has justifiable=true', async () => {
      (mockPrisma.behaviorTypeReference.findUnique as jest.Mock).mockResolvedValue({
        code: 11,
        justifiable: true,
      });
      const result = await service.isJustifiable(11);
      expect(result).toBe(true);
    });

    it('returns false when the behavior type reference has justifiable=false', async () => {
      (mockPrisma.behaviorTypeReference.findUnique as jest.Mock).mockResolvedValue({
        code: 2,
        justifiable: false,
      });
      const result = await service.isJustifiable(2);
      expect(result).toBe(false);
    });

    it('returns false when the behavior type reference is not found', async () => {
      (mockPrisma.behaviorTypeReference.findUnique as jest.Mock).mockResolvedValue(null);
      const result = await service.isJustifiable(9999);
      expect(result).toBe(false);
    });

    it('returns false when prisma throws an error', async () => {
      (mockPrisma.behaviorTypeReference.findUnique as jest.Mock).mockRejectedValue(
        new Error('DB connection error'),
      );
      const result = await service.isJustifiable(1);
      expect(result).toBe(false);
    });
  });
});
