/**
 * Whole-application route-table self-test (ROLE_PERMISSION_AND_AUDIT_LOGS.md §7, AUTH §19):
 * every registered module's admin routes declare a permission guard, critical permissions carry
 * requireReauth, and no two modules register the same METHOD + path. MOCKED container (no DB).
 */
import { describe, expect, it } from 'vitest';

import { MODULE_FACTORIES } from '../../src/modules/index.js';
import { buildModules } from '../../src/routes/v1.js';
import { buildModuleTestApp } from '../helpers/container.js';
import { REAUTH_EXEMPT } from '../../src/core/http/routeTable.js';
import { expectAdminRoutesGuarded, listRoutes } from '../helpers/routeTable.js';

describe('route table (all registered modules)', () => {
  const t = buildModuleTestApp([]);
  const modules = buildModules(t.container, MODULE_FACTORIES);

  it('registers every module with a unique name', () => {
    const names = modules.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(modules.map((m) => [m.name, m] as const))(
    '%s: admin routes are guarded',
    (_name, module) => {
      expectAdminRoutesGuarded(module, REAUTH_EXEMPT[module.name] ?? []);
    },
  );

  it('has no duplicate METHOD + path across modules', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const module of modules) {
      const groups = [
        ['admin', module.adminPublicRouter],
        ['admin', module.adminRouter],
        ['public', module.publicRouter],
        ['webhook', module.webhookRouter],
      ] as const;
      for (const [prefix, router] of groups) {
        if (router === undefined) continue;
        for (const route of listRoutes(router)) {
          const key = `${route.method} ${prefix}${route.path}`;
          const owner = seen.get(key);
          if (owner !== undefined && owner !== module.name)
            duplicates.push(`${key} (${owner}, ${module.name})`);
          seen.set(key, module.name);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });
});
