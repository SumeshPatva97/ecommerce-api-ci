/**
 * D-57: seller GSTIN is read from the canonical `tax.seller_gstin` key; the duplicate
 * `store.gstin` / `store.state_code` settings are gone. MOCKED DB.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { KNOWN_SETTING_RULES } from '../../../../src/modules/settings/settings.values.js';
import { createSettingsModule } from '../../../../src/modules/settings/index.js';
import { withPublicGstin } from '../../../../src/modules/settings/settings.service.js';
import { buildModuleTestApp } from '../../../helpers/container.js';

describe('seller GSTIN canonical key (D-57)', () => {
  it('publishes store.gstin on /settings/public from tax.seller_gstin when configured', async () => {
    const t = buildModuleTestApp([createSettingsModule]);
    t.m.setting.findMany.mockResolvedValue([
      { settingKey: 'store.name', groupKey: 'store', value: 'Brand', isPublic: true },
    ]);
    t.m.setting.findUnique.mockResolvedValue({ value: '27ABCDE1234F1Z5' });
    const res = await request(t.app).get('/api/v1/settings/public');
    expect(res.status).toBe(200);
    expect(res.body.data.store).toEqual({ name: 'Brand', gstin: '27ABCDE1234F1Z5' });
    expect(t.m.setting.findUnique).toHaveBeenCalledWith({
      where: { settingKey: 'tax.seller_gstin' },
      select: { value: true },
    });
  });

  it('omits the GSTIN while it is not configured', () => {
    expect(withPublicGstin({ store: { name: 'B' } }, undefined)).toEqual({ store: { name: 'B' } });
    expect(withPublicGstin({ store: { name: 'B' } }, '  ')).toEqual({ store: { name: 'B' } });
    expect(withPublicGstin({}, '29ABCDE1234F1Z5')).toEqual({ store: { gstin: '29ABCDE1234F1Z5' } });
  });

  it('no longer accepts the duplicate store.gstin / store.state_code keys', () => {
    expect(KNOWN_SETTING_RULES['store.gstin']).toBeUndefined();
    expect(KNOWN_SETTING_RULES['store.state_code']).toBeUndefined();
  });
});
