/**
 * Startup self-check (AUTHENTICATION_AUTHORIZATION §19, ROLE_PERMISSION_AND_AUDIT_LOGS §7): the v1
 * router refuses to build when an admin route is unguarded or a critical route lacks re-auth.
 * MOCKED container — no DB.
 */
import { Router } from 'express';
import { describe, expect, it } from 'vitest';

import { createV1Router } from '../../../src/routes/v1.js';
import { buildModuleTestApp } from '../../helpers/container.js';

describe('admin route startup self-check', () => {
  const { container } = buildModuleTestApp([]);

  it('refuses to start with an admin route that has no permission guard', () => {
    const adminRouter = Router();
    adminRouter.get('/open', (_req, res) => res.end());
    expect(() => createV1Router(container, [{ name: 'bad', adminRouter }])).toThrow(
      /Admin route self-check failed:[\s\S]*bad: GET \/open has no permission guard/,
    );
  });

  it('refuses to start with a critical permission but no re-auth', () => {
    const adminRouter = Router();
    adminRouter.post('/roles', container.auth.requirePermission('roles.create'), (_req, res) =>
      res.end(),
    );
    expect(() => createV1Router(container, [{ name: 'roles-bad', adminRouter }])).toThrow(
      /roles-bad: POST \/roles uses a critical permission without requireReauth/,
    );
  });

  it('starts with guarded routes and declared self-service paths', () => {
    const adminRouter = Router();
    adminRouter.get('/things', container.auth.requirePermission('products.view'), (_req, res) =>
      res.end(),
    );
    adminRouter.post(
      '/roles',
      container.auth.requirePermission('roles.create'),
      container.auth.requireReauth(),
      (_req, res) => res.end(),
    );
    adminRouter.get('/auth/me', (_req, res) => res.end());
    expect(() =>
      createV1Router(container, [{ name: 'ok', adminRouter, selfServiceAdminPaths: ['/auth/me'] }]),
    ).not.toThrow();
  });
});
