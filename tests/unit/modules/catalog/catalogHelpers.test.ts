/**
 * Pure catalog-master helpers: category tree/path maths, rule inheritance merge, attribute code
 * generation, audit action selection and schema rules. No DB (MOCKED / pure unit tests).
 */
import { describe, expect, it } from 'vitest';

import { codeFromName } from '../../../../src/modules/attributes/attributes.service.js';
import {
  CreateAttributeValueBody,
  UpdateAttributeBody,
} from '../../../../src/modules/attributes/attributes.schemas.js';
import { changedKeys, updateAction } from '../../../../src/modules/catalog-common/catalog.audit.js';
import { compact, imageColumns } from '../../../../src/modules/catalog-common/catalog.mapper.js';
import { statusWhere } from '../../../../src/modules/catalog-common/catalog.schemas.js';
import { CreateCategoryBody } from '../../../../src/modules/categories/categories.schemas.js';
import { mergeRules } from '../../../../src/modules/categories/categories.service.js';
import {
  buildTree,
  childPath,
  idsFromPath,
  isSelfOrDescendant,
  rebaseSubtree,
  subtreeHeight,
} from '../../../../src/modules/categories/categories.tree.js';
import { CreateCollectionBody } from '../../../../src/modules/collections/collections.schemas.js';
import {
  attributeRow,
  categoryRow,
  childOf,
} from '../../../integration/modules/catalog/fixtures.js';

describe('category path helpers', () => {
  it('derives ids, child paths and descendant checks', () => {
    expect(idsFromPath('/a/b/c/')).toEqual(['a', 'b', 'c']);
    expect(childPath(null, 'a')).toBe('/a/');
    expect(childPath('/a/', 'b')).toBe('/a/b/');
    expect(isSelfOrDescendant('/a/b/', 'a')).toBe(true);
    expect(isSelfOrDescendant('/a/b/', 'b')).toBe(true);
    expect(isSelfOrDescendant('/x/y/', 'a')).toBe(false);
    expect(subtreeHeight(1, [1, 2, 3])).toBe(2);
    expect(subtreeHeight(2, [2])).toBe(0);
  });

  it('rebases descendants, excluding the moved root', () => {
    const rows = [
      { id: 'a', path: '/a/', depth: 1 },
      { id: 'b', path: '/a/b/', depth: 2 },
      { id: 'c', path: '/a/b/c/', depth: 3 },
    ];
    expect(rebaseSubtree(rows.slice(0, 2), '/a/', '/x/a/', 1)).toEqual([
      { id: 'b', path: '/x/a/b/', depth: 3 },
    ]);
    expect(rebaseSubtree(rows, '/a/b/', '/b/', -1)).toEqual([{ id: 'c', path: '/b/c/', depth: 2 }]);
  });
});

describe('buildTree', () => {
  const row = (id: string, parentId: string | null, own: number, sortOrder = 0, name = id) => ({
    id,
    parentId,
    sortOrder,
    name,
    ownProductCount: own,
  });

  it('sorts siblings, rolls up counts and drops orphans in storefront mode', () => {
    const tree = buildTree(
      [
        row('r2', null, 0, 2),
        row('r1', null, 1, 1),
        row('c2', 'r1', 2, 0, 'Zeta'),
        row('c1', 'r1', 3, 0, 'Alpha'),
        row('g', 'c1', 4),
        row('orphan', 'missing', 9),
      ],
      { orphans: 'drop' },
    );
    expect(tree.map((n) => n.id)).toEqual(['r1', 'r2']);
    expect(tree[0]?.productCount).toBe(10);
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['c1', 'c2']);
    expect(tree[0]?.children[0]?.productCount).toBe(7);
  });

  it('keeps orphans as roots in admin mode and prunes by depth without losing counts', () => {
    const tree = buildTree([row('r', null, 1), row('c', 'r', 2), row('o', 'missing', 5)], {
      orphans: 'root',
      maxDepth: 1,
    });
    expect(tree.map((n) => n.id)).toEqual(['o', 'r']);
    const r = tree.find((n) => n.id === 'r');
    expect(r).toMatchObject({ productCount: 3, children: [] });
  });
});

describe('mergeRules', () => {
  it('lets the nearest category win and skips non-inheritable ancestor rules', () => {
    const root = categoryRow();
    const child = childOf(root, { name: 'Child', slug: 'child' });
    const a = attributeRow({ name: 'A', code: 'a' });
    const b = attributeRow({ name: 'B', code: 'b' });
    const deleted = attributeRow({ name: 'D', code: 'd', deletedAt: new Date() });
    const base = {
      isRequired: false,
      isVariantAxisDefault: false,
      inheritToChildren: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const rules = mergeRules(
      [root, child],
      [
        { ...base, categoryId: root.id, attributeId: a.id, attribute: a, isRequired: true },
        { ...base, categoryId: root.id, attributeId: b.id, attribute: b, inheritToChildren: false },
        { ...base, categoryId: child.id, attributeId: a.id, attribute: a, sortOrder: 3 },
        { ...base, categoryId: child.id, attributeId: deleted.id, attribute: deleted },
      ],
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ attributeId: a.id, isRequired: false, inheritedFrom: null });
  });
});

describe('attribute code generation', () => {
  it('derives snake_case codes and avoids reserved listing keys', () => {
    expect(codeFromName('Metal Finish')).toBe('metal_finish');
    expect(codeFromName('Ring Size (mm)')).toBe('ring_size_mm');
    expect(codeFromName('Category')).toBe('category_attr');
    expect(codeFromName('***')).toBe('attr');
  });
});

describe('audit helpers', () => {
  it('reports STATUS_CHANGE only when the active flag alone changed', () => {
    expect(updateAction(['isActive'])).toBe('STATUS_CHANGE');
    expect(updateAction(['isActive', 'name'])).toBe('UPDATE');
    expect(updateAction(['sortOrder'])).toBe('UPDATE');
  });

  it('detects changed keys including explicit null clears', () => {
    expect(changedKeys({ a: 1, b: 'x', c: null }, { a: 1, b: null, c: null })).toEqual(['b']);
  });

  it('compact keeps nulls but drops undefined; imageColumns clears on null', () => {
    expect(compact({ a: undefined, b: null, c: 1 })).toEqual({ b: null, c: 1 });
    expect(imageColumns(null)).toEqual({ url: null, publicId: null });
    expect(imageColumns(undefined)).toBeUndefined();
  });

  it('maps admin status filters to soft-delete aware where clauses', () => {
    expect(statusWhere(undefined)).toEqual({ deletedAt: null });
    expect(statusWhere('INACTIVE')).toEqual({ deletedAt: null, isActive: false });
    expect(statusWhere('DELETED')).toEqual({ deletedAt: { not: null } });
  });
});

describe('schemas', () => {
  it('trims names and enforces 2–80 characters on categories', () => {
    expect(CreateCategoryBody.parse({ name: '  Rings ' }).name).toBe('Rings');
    expect(CreateCategoryBody.safeParse({ name: 'R' }).success).toBe(false);
    expect(CreateCategoryBody.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('requires https image URLs and strict bodies', () => {
    const http = CreateCategoryBody.safeParse({
      name: 'Rings',
      image: { url: 'http://res.cloudinary.com/a', publicId: 'a' },
    });
    expect(http.success).toBe(false);
    expect(CreateCategoryBody.safeParse({ name: 'Rings', depth: 2 }).success).toBe(false);
  });

  it('validates collection windows and attribute value hex colours', () => {
    expect(
      CreateCollectionBody.safeParse({
        name: 'Edit',
        startsAt: '2026-12-01T00:00:00Z',
        endsAt: '2026-12-01T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(CreateAttributeValueBody.parse({ value: 'Gold', hexColor: '#c9a96e' }).hexColor).toBe(
      '#C9A96E',
    );
    expect(UpdateAttributeBody.safeParse({}).success).toBe(false);
  });
});
