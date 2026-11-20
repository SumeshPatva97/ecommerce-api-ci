/**
 * M1 correction — lost-race recovery for the TRANSACTIONAL cart paths (`POST /cart/items`,
 * `POST /cart/merge`), through the real routes and service.
 *
 * MOCKED DB. An in-memory carts state stands in for MySQL, and "concurrent requests" are simulated
 * by mutating that state at the moment the losing request's statement runs. These tests prove the
 * service's control flow: resolution happens before the transaction, the claim is the
 * transaction's first statement, recovery uses the winner's cart, retry and 409 behave as designed,
 * and unrelated errors propagate.
 *
 * They do NOT prove MySQL behaviour: REPEATABLE READ snapshots, that an UPDATE is a current read
 * that locks the row, the real P2002 from `uq_carts_active_owner`, or true concurrency. Those are
 * MySQL-only checks for the integration suite after G7/G8.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCartModule } from '../../../../src/modules/cart/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { IDS, jhumka, primeCart, variantCheck } from './fixtures.js';

const WINNER = '0b3e3c1e-2222-4a5b-8c9d-000000000003';

function p2002(): Error {
  return Object.assign(new Error('Unique constraint failed on uq_carts_active_owner'), {
    code: 'P2002',
    clientVersion: '7.10.1',
    meta: { target: 'uq_carts_active_owner' },
  });
}

interface Where {
  status?: string;
  id?: string;
  userId?: string;
}
interface CartLike {
  id: string;
}

/**
 * State model: at most one ACTIVE cart (the database guarantee) plus an optional ABANDONED cart.
 * `onReactivate` / `onCreate` / `onClaim` let a test inject what a concurrent request did.
 */
function setup(o: { abandoned?: boolean } = {}) {
  const t = buildModuleTestApp([createCartModule]);
  const customer = t.customer();
  const userId = customer.ctx.userId;
  const base = primeCart(t, { userId, items: [jhumka()] });
  const state: { active: CartLike | null; abandoned: CartLike | null } = {
    active: null,
    abandoned: o.abandoned === false ? null : { id: base.id },
  };
  const hooks: {
    onReactivate?: () => number | Error;
    onCreate?: () => Error | undefined;
    onClaim?: (attempt: number) => number | Error;
  } = {};
  let claims = 0;
  const cartView = (id: string) => ({ ...base, id, items: id === base.id ? base.items : [] });

  t.m.cart.findFirst.mockImplementation((args: { where: Where }) => {
    if (args.where.status === 'ACTIVE') {
      return Promise.resolve(state.active === null ? null : cartView(state.active.id));
    }
    if (args.where.status === 'ABANDONED') return Promise.resolve(state.abandoned);
    return Promise.resolve(null);
  });
  t.m.cart.updateMany.mockImplementation((args: { where: Where }) => {
    if (args.where.status === 'ACTIVE') {
      claims += 1;
      const injected = hooks.onClaim?.(claims);
      if (injected instanceof Error) return Promise.reject(injected);
      if (injected !== undefined) return Promise.resolve({ count: injected });
      const ok = state.active?.id === args.where.id && args.where.userId === userId;
      return Promise.resolve({ count: ok ? 1 : 0 });
    }
    // reactivation compare-and-set
    const injected = hooks.onReactivate?.();
    if (injected instanceof Error) return Promise.reject(injected);
    if (injected !== undefined) return Promise.resolve({ count: injected });
    if (state.abandoned?.id === args.where.id) {
      state.active = state.abandoned;
      state.abandoned = null;
      return Promise.resolve({ count: 1 });
    }
    return Promise.resolve({ count: 0 });
  });
  t.m.cart.create.mockImplementation((args: { data: { id: string } }) => {
    const injected = hooks.onCreate?.();
    if (injected !== undefined) return Promise.reject(injected);
    if (state.active !== null) return Promise.reject(p2002()); // uq_carts_active_owner
    state.active = { id: args.data.id };
    return Promise.resolve(cartView(args.data.id));
  });
  t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
  t.m.productVariant.findMany.mockResolvedValue([
    variantCheck({ id: IDS.vOther }),
    variantCheck({ id: IDS.vRing }),
  ]);
  t.m.cartItem.findUnique.mockResolvedValue(null);
  t.m.cartItem.findMany.mockResolvedValue([]);
  t.m.cartItem.count.mockResolvedValue(0);
  const itemCartIds = () =>
    t.m.cartItem.create.mock.calls.map((c) => (c[0] as { data: { cartId: string } }).data.cartId);
  return {
    t,
    auth: customer.headers,
    userId,
    base,
    state,
    hooks,
    itemCartIds,
    claimsMade: () => claims,
  };
}

const addItem = (t: ReturnType<typeof setup>['t'], auth: Record<string, string>) =>
  request(t.app).post('/api/v1/cart/items').set(auth).send({ variantId: IDS.vOther, quantity: 1 });
const merge = (t: ReturnType<typeof setup>['t'], auth: Record<string, string>) =>
  request(t.app)
    .post('/api/v1/cart/merge')
    .set(auth)
    .send({
      items: [
        { variantId: IDS.vOther, quantity: 1 },
        { variantId: IDS.vRing, quantity: 2 },
      ],
    });

describe('M1: transactional lost-race recovery (mocked)', () => {
  it('addItem: lost reactivation compare-and-set → uses the winner cart (no 409, no new cart)', async () => {
    const { t, auth, base, state, hooks, itemCartIds } = setup();
    hooks.onReactivate = () => {
      // A concurrent request (e.g. GET /cart) reactivated it first.
      state.active = state.abandoned;
      state.abandoned = null;
      return 0;
    };
    const res = await addItem(t, auth);
    expect(res.status).toBe(201);
    expect(itemCartIds()).toEqual([base.id]);
    expect(t.m.cart.create).not.toHaveBeenCalled();
  });

  it('addItem: P2002 on first-visit create → uses the cart the concurrent request created', async () => {
    const { t, auth, state, hooks, itemCartIds } = setup({ abandoned: false });
    hooks.onCreate = () => {
      state.active = { id: WINNER };
      return p2002();
    };
    const res = await addItem(t, auth);
    expect(res.status).toBe(201);
    expect(itemCartIds()).toEqual([WINNER]);
    expect(t.m.cart.create).toHaveBeenCalledTimes(1); // no second ACTIVE cart
  });

  it('merge: P2002 on reactivation → every guest item lands in the winner cart', async () => {
    const { t, auth, state, hooks, itemCartIds } = setup();
    hooks.onReactivate = () => {
      state.active = { id: WINNER }; // a concurrent request created a new ACTIVE cart
      return p2002();
    };
    const res = await merge(t, auth);
    expect(res.status).toBe(200);
    expect(itemCartIds()).toEqual([WINNER, WINNER]);
    expect(res.body.data.warnings).toEqual([]);
    expect(t.m.cart.create).not.toHaveBeenCalled();
  });

  it('claim fails once (cart converted/replaced after resolution) → re-resolves and writes only to the current cart', async () => {
    const { t, auth, base, state, hooks, itemCartIds, claimsMade } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = (attempt) => {
      if (attempt === 1) {
        state.active = { id: WINNER }; // e.g. converted by checkout, a new cart created meanwhile
        return 0;
      }
      return 1;
    };
    const res = await merge(t, auth);
    expect(res.status).toBe(200);
    expect(claimsMade()).toBe(2);
    expect(itemCartIds()).toEqual([WINNER, WINNER]); // nothing was written in the failed attempt
  });

  it('claim fails twice → 409 CONFLICT and NO guest item is written (not silently lost: the client keeps them)', async () => {
    const { t, auth, base, state, hooks, claimsMade } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = () => 0;
    const res = await merge(t, auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(claimsMade()).toBe(2);
    expect(t.m.cartItem.create).not.toHaveBeenCalled();
    expect(t.m.cartItem.update).not.toHaveBeenCalled();
  });

  it('the claim is the first statement of the transaction and is scoped to the customer', async () => {
    const { t, auth, userId, base, state } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    await addItem(t, auth).expect(201);
    const claim = t.m.cart.updateMany.mock.calls.find(
      (c) => (c[0] as { where: Where }).where.status === 'ACTIVE',
    )?.[0] as { where: Where; data: { lastActivityAt: Date } } | undefined;
    expect(claim?.where).toEqual({ id: base.id, userId, status: 'ACTIVE' });
    expect(claim?.data.lastActivityAt).toBeInstanceOf(Date);
    const claimOrder = t.m.cart.updateMany.mock.invocationCallOrder.at(-1) ?? 0;
    expect(claimOrder).toBeLessThan(t.m.productVariant.findUnique.mock.invocationCallOrder[0] ?? 0);
    expect(claimOrder).toBeLessThan(t.m.cartItem.create.mock.invocationCallOrder[0] ?? 0);
  });

  it('unrelated database errors propagate (create and claim) without retry or recovery', async () => {
    const create = setup({ abandoned: false });
    create.hooks.onCreate = () => new Error('Connection lost');
    expect((await addItem(create.t, create.auth)).status).toBe(500);
    expect(create.t.m.cartItem.create).not.toHaveBeenCalled();

    const claim = setup();
    claim.state.active = { id: claim.base.id };
    claim.state.abandoned = null;
    // (A lock-wait timeout would surface as 409 CONFLICT via the existing withTransaction mapping.)
    claim.hooks.onClaim = () => new Error('Server has gone away');
    expect((await merge(claim.t, claim.auth)).status).toBe(500);
    expect(claim.claimsMade()).toBe(1);
    expect(claim.t.m.cartItem.create).not.toHaveBeenCalled();
  });
});

describe('WP10-6: Batch 8 gaps — re-resolution that creates a cart, add-item retry (mocked)', () => {
  it('addItem: claim fails because the cart was converted and nothing else exists → re-resolution CREATES a new cart and writes only there', async () => {
    const { t, auth, base, state, hooks, itemCartIds, claimsMade } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = (attempt) => {
      if (attempt === 1) {
        state.active = null; // converted by a concurrent checkout; no ACTIVE / ABANDONED cart left
        return 0;
      }
      return 1; // the claim of the newly created cart succeeds (claimed id asserted below)
    };
    const res = await addItem(t, auth);
    expect(res.status).toBe(201);
    expect(claimsMade()).toBe(2);
    expect(t.m.cart.create).toHaveBeenCalledTimes(1);
    const createdId = (t.m.cart.create.mock.calls[0]?.[0] as { data: { id: string } }).data.id;
    expect(createdId).not.toBe(base.id);
    expect(state.active).toEqual({ id: createdId });
    expect(itemCartIds()).toEqual([createdId]); // never the converted cart
    const claimIds = t.m.cart.updateMany.mock.calls
      .map((c) => c[0] as { where: Where })
      .filter((a) => a.where.status === 'ACTIVE')
      .map((a) => a.where.id);
    expect(claimIds).toEqual([base.id, createdId]);
  });

  it('merge: same re-resolution creates a new cart and every guest item lands in it', async () => {
    const { t, auth, base, state, hooks, itemCartIds } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = (attempt) => {
      if (attempt === 1) {
        state.active = null;
        return 0;
      }
      return 1;
    };
    const res = await merge(t, auth);
    expect(res.status).toBe(200);
    expect(t.m.cart.create).toHaveBeenCalledTimes(1);
    const createdId = (t.m.cart.create.mock.calls[0]?.[0] as { data: { id: string } }).data.id;
    expect(itemCartIds()).toEqual([createdId, createdId]);
  });

  it('addItem retry: claim fails once (cart replaced) → re-resolves and adds the line only to the current cart', async () => {
    const { t, auth, base, state, hooks, itemCartIds, claimsMade } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = (attempt) => {
      if (attempt === 1) {
        state.active = { id: WINNER };
        return 0;
      }
      return 1;
    };
    const res = await addItem(t, auth);
    expect(res.status).toBe(201);
    expect(claimsMade()).toBe(2);
    expect(itemCartIds()).toEqual([WINNER]);
    expect(t.m.cart.create).not.toHaveBeenCalled();
    // Nothing was written in the failed attempt: the variant check runs only after a successful claim.
    expect(t.m.productVariant.findUnique).toHaveBeenCalledTimes(1);
  });

  it('addItem retry: claim fails twice → 409 CONFLICT and no line is written', async () => {
    const { t, auth, base, state, hooks, claimsMade } = setup();
    state.active = { id: base.id };
    state.abandoned = null;
    hooks.onClaim = () => 0;
    const res = await addItem(t, auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(claimsMade()).toBe(2);
    expect(t.m.cartItem.create).not.toHaveBeenCalled();
    expect(t.m.cartItem.update).not.toHaveBeenCalled();
  });
});
