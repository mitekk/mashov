import {
  BadGatewayException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import {
  createMashovAxios,
  isUpstreamUnreachable,
  resolveMashovBaseUrl,
} from '../http/mashov-http';

/** What Mashov tells us about an account when the credentials are good. */
export interface MashovLoginResult {
  data: MashovLoginPayload;
  /** The `uniquId` cookie, if the response set one. */
  newUniqueId: string | undefined;
}

export interface MashovLoginPayload {
  credential?: {
    userId?: string;
    displayName?: string;
    semel?: number;
    year?: number;
  };
  accessToken?: {
    userSettings?: { detailsState?: number };
    schoolSettings?: { schoolName?: string; schoolYear?: number };
    children?: Array<{
      childGuid: string;
      familyName: string;
      privateName: string;
      classCode: string;
      classNum: number;
      gender: string;
      groups: number[];
    }>;
    inactiveChildren?: unknown[];
    userSchoolYears?: number[];
    username?: string;
  };
}

export interface ValidateCredentialsInput {
  semel: number;
  year: number;
  username: string;
  password: string;
  /** A stored `uniquId`, sent so Mashov recognises a known device. */
  uniqueId?: string | null;
}

/**
 * One POST /api/login, and one place that decides what a failure means.
 *
 * This logic existed three times -- AuthService.login,
 * ConnectionService.updateConnection, and now school linking -- each with its
 * own copy of the 15-field login body and its own `uniquId` cookie parsing.
 * Three copies of a security decision is two too many: the important part is
 * the split below, and a copy that drifts tells a parent their password is
 * wrong during an upstream outage.
 */
@Injectable()
export class MashovCredentialValidatorService {
  private readonly logger = new Logger(MashovCredentialValidatorService.name);
  private readonly baseUrl: string;
  /** Shared Mashov client: applies the egress proxy and the abort-signal timeout. */
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = resolveMashovBaseUrl(
      this.configService.get<string>('MASHOV_BASE_URL'),
    );
    this.http = createMashovAxios(this.baseUrl);
  }

  /**
   * Validate credentials against Mashov, or throw a classified error.
   *
   * The split is the point, and is preserved verbatim from the original:
   * an unreachable upstream is `UPSTREAM_ERROR` (502), never
   * `INVALID_CREDENTIALS`. Reporting an outage as a bad password sends the
   * parent round a loop retyping a password that was correct all along, and
   * they have no way to tell the difference.
   */
  async validate(input: ValidateCredentialsInput): Promise<MashovLoginResult> {
    try {
      return await this.postLogin(input);
    } catch (err) {
      if (isUpstreamUnreachable(err)) {
        this.logger.error(
          `Mashov login unreachable for semel=${input.semel}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        throw new BadGatewayException({
          error: {
            code: 'UPSTREAM_ERROR',
            message: 'Mashov is not reachable right now. Please try again shortly.',
            details: [],
          },
        });
      }

      // Everything else -- a 401, a 403, an unparseable body -- is treated as
      // bad credentials. Deliberately generic: per .claude/rules/security.md
      // an auth failure must not reveal whether the username exists.
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials, please try again',
          details: [],
        },
      });
    }
  }

  /**
   * One POST, no error handling. Separated because year reconciliation runs it
   * twice and both attempts share `validate`'s classification.
   */
  async postLogin(input: ValidateCredentialsInput): Promise<MashovLoginResult> {
    const csrfToken = '9c690c16-d0c8-ed43-9314-d622077e2e26';

    const loginBody = {
      semel: Number(input.semel),
      year: Number(input.year),
      username: input.username,
      password: input.password,
      IsBiometric: false,
      appName: 'info.mashov.students',
      apiVersion: '3.20210425',
      appVersion: 3.20210425,
      appBuild: 3.20210425,
      deviceUuid: 'chrome',
      devicePlatform: 'chrome',
      deviceManufacturer: 'mac',
      deviceModel: 'desktop',
      deviceVersion: '145.0.0.0',
    };

    const extraHeaders: Record<string, string> = {};
    if (input.uniqueId) {
      extraHeaders['Cookie'] = `uniquId=${input.uniqueId}`;
    }

    const response = await this.http.post<MashovLoginPayload>('/api/login', loginBody, {
      headers: {
        'X-Csrf-Token': csrfToken,
        'Content-Type': 'application/json',
        Referer: `${this.baseUrl}/students/login`,
        ...extraHeaders,
      },
    });

    return {
      data: response.data,
      newUniqueId: readUniqueIdCookie(response.headers?.['set-cookie']),
    };
  }

  /** True when an error is an upstream outage rather than a rejection. */
  isUnreachable(error: unknown): boolean {
    return isUpstreamUnreachable(error);
  }

  /** True when Mashov actively rejected the credentials. */
  isRejection(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 401;
  }
}

/** The `uniquId` Mashov sets, if it set one. */
function readUniqueIdCookie(setCookie: string | string[] | undefined): string | undefined {
  if (!setCookie) return undefined;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const cookie of cookies) {
    const nameValue = cookie.split(';')[0] ?? '';
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx !== -1 && nameValue.substring(0, eqIdx).trim() === 'uniquId') {
      return nameValue.substring(eqIdx + 1).trim();
    }
  }
  return undefined;
}
