/**
 * Manual probe: a blackholed egress proxy must surface as our 502, inside the
 * `MASHOV_TIMEOUT_MS` budget — never as an invalid recovery code.
 *
 * This is the one failure mode that cannot be mocked honestly. Axios' own
 * `timeout` is armed by `req.setTimeout()`, which only starts counting once a
 * socket is assigned, and `HttpsProxyAgent` defers socket assignment until its
 * CONNECT completes. A proxy that DROPS packets (rather than refusing them)
 * therefore never arms it, and the request hangs forever. The AbortSignal in
 * `createMashovAxios` is the only thing that bounds it, and the only way to
 * know it works is to point at a blackhole.
 *
 * Not a unit test: it needs a real socket, real wall-clock time, and ~3s. Run
 * it by hand:
 *
 *   cd backend && npx tsx test/manual/blackhole-proxy.probe.ts
 */
import { ConfigService } from '@nestjs/config';
import { isUpstreamUnreachable } from '../../src/common/http/mashov-http';
import { MashovRecoveryService } from '../../src/common/mashov-login/mashov-recovery.service';

const TIMEOUT_MS = 3000;

// 198.51.100.0/24 is TEST-NET-2 (RFC 5737): reserved for documentation and
// routed nowhere, so a connect to it is dropped rather than refused. A closed
// local port would be REFUSED, which is a different and much easier case.
process.env.HTTPS_PROXY = 'http://198.51.100.1:9';
process.env.MASHOV_TIMEOUT_MS = String(TIMEOUT_MS);

async function main(): Promise<void> {
  const service = new MashovRecoveryService(
    new ConfigService({ MASHOV_BASE_URL: 'https://web.mashov.info' }),
  );

  const startedAt = Date.now();
  try {
    await service.requestRecovery({ semel: 1, idNumber: '000000000', email: true });
    fail('the request RESOLVED through a blackholed proxy, which cannot be right');
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    const unreachable = isUpstreamUnreachable(err);

    console.log(`elapsed=${elapsed}ms unreachable=${unreachable}`);

    if (!unreachable) {
      fail(
        'the failure did NOT classify as unreachable, so it would be reported ' +
          'as an invalid code rather than a 502',
      );
    }
    // Generous ceiling: the budget plus scheduling slack. The thing being
    // checked is that it is BOUNDED at all.
    if (elapsed > TIMEOUT_MS * 3) {
      fail(`the abort signal did not bound the request (${elapsed}ms)`);
    }

    console.log('PASS: a blackholed proxy is bounded and classifies as UPSTREAM_ERROR');
  }
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

void main();
