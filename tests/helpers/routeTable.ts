/**
 * Test wrapper around the runtime route-table self-check (`src/core/http/routeTable.ts`), so tests and
 * application startup enforce exactly the same rules.
 */
import { expect } from 'vitest';

import {
  adminRouteViolations,
  listRoutes,
  type RouteInfo,
} from '../../src/core/http/routeTable.js';
import type { ApiModule } from '../../src/modules/types.js';

export { listRoutes, type RouteInfo };

/**
 * Asserts guards on `module.adminRouter`. Critical keys that intentionally do not require re-auth are
 * passed in `reauthExempt` as `METHOD path` (defaults to the documented runtime exemption list).
 */
export function expectAdminRoutesGuarded(
  module: ApiModule,
  reauthExempt?: readonly string[],
): RouteInfo[] {
  const problems =
    reauthExempt === undefined
      ? adminRouteViolations(module)
      : adminRouteViolations(module, reauthExempt);
  if (problems.length > 0) {
    const kind = problems[0]?.includes('no permission guard')
      ? 'has no permission guard'
      : 'uses a critical permission without requireReauth';
    expect(problems, `${problems.join('; ')} (${kind})`).toEqual([]);
  }
  return module.adminRouter === undefined ? [] : listRoutes(module.adminRouter);
}
