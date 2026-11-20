/**
 * RD-08 option B — reactivation of the newest ABANDONED cart through the real cart routes.
 *
 * MOCKED DB: a tiny in-memory "carts" state behind `cart.findFirst` / `cart.updateMany` /
 * `cart.create`. It proves the service's decisions (which query, which compare-and-set, what to do
 * after losing a race). It does NOT prove MySQL behaviour: the one-ACTIVE-cart guarantee comes from
 * the database's unique `uq_carts_active_owner`, which the mocks only imitate by throwing P2002.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createCartModule } from '../../../../src/modules/cart/index.js';
import { buildModuleTestApp } from '../../../helpers/container.js';
import { IDS, jhumka, primeCart, variantCheck } from './fixtures.js';

const OTHER_CART = '0b3e3c1e-1111-4a5b-8c9d-000000000002';

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
}

/** Customer with one ABANDONED cart (with items) and no ACTIVE cart. */
function setup() {
  const t = buildModuleTestApp([createCartModule]);
  const customer = t.customer();
  const cart = primeCart(t, { items: [jhumka()] });
  type CartState = Omit<typeof cart, 'id'> & { id: string };
  const state: { active: CartState | null; abandoned: CartState | null } = {
    active: null,
    abandoned: cart,
  };
  t.m.cart.findFirst.mockImplementation((args: { where: Where }) =>
    Promise.resolve(
      args.where.status === 'ACTIVE'
        ? state.active
        : args.where.status === 'ABANDONED'
          ? state.abandoned === null
            ? null
            : { id: state.abandoned.id }
          : null,
    ),
  );
  t.m.cart.updateMany.mockImplementation((args: { where: Where }) => {
    // M1 claim: succeeds only for the cart that is currently ACTIVE.
    if (args.where.status === 'ACTIVE') {
      return Promise.resolve({ count: state.active?.id === args.where.id ? 1 : 0 });
    }
    if (args.where.status === 'ABANDONED' && state.abandoned?.id === args.where.id) {
      state.active = state.abandoned;
      state.abandoned = null;
      return Promise.resolve({ count: 1 });
    }
    return Promise.resolve({ count: 0 });
  });
  return { t, auth: customer.headers, cart, state };
}

describe('RD-08 cart reactivation', () => {
  it('reactivates the newest ABANDONED cart with its items instead of creating a new cart', async () => {
    const { t, auth, cart } = setup();
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: cart.id, itemCount: 2 });
    expect(res.body.data.items).toHaveLength(1);
    expect(t.m.cart.create).not.toHaveBeenCalled();

    const abandonedLookup = t.m.cart.findFirst.mock.calls.find(
      (c) => (c[0] as { where: Where }).where.status === 'ABANDONED',
    )?.[0];
    expect(abandonedLookup).toMatchObject({
      where: { status: 'ABANDONED' },
      orderBy: [{ abandonedAt: 'desc' }, { lastActivityAt: 'desc' }, { id: 'desc' }],
    });
    expect(t.m.cart.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: cart.id, status: 'ABANDONED' }, // compare-and-set
      data: { status: 'ACTIVE', abandonedAt: null },
    });
  });

  it('a request that loses the compare-and-set uses the cart reactivated by the other request', async () => {
    const { t, auth, cart, state } = setup();
    // The concurrent request already reactivated it: our UPDATE … WHERE status = ABANDONED hits 0 rows.
    t.m.cart.updateMany.mockImplementationOnce(() => {
      state.active = state.abandoned;
      state.abandoned = null;
      return Promise.resolve({ count: 0 });
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(cart.id);
    expect(t.m.cart.create).not.toHaveBeenCalled();
  });

  it('never makes a second ACTIVE cart: P2002 on reactivation → use the ACTIVE cart that won', async () => {
    const { t, auth, cart, state } = setup();
    t.m.cart.updateMany.mockImplementationOnce(() => {
      // A concurrent first request created a NEW active cart meanwhile; uq_carts_active_owner rejects ours.
      state.active = { ...cart, id: OTHER_CART, items: [] };
      return Promise.reject(p2002());
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(OTHER_CART);
    expect(t.m.cart.create).not.toHaveBeenCalled();
    expect(state.abandoned?.id).toBe(cart.id); // left ABANDONED (still recoverable later)
  });

  it('first visit race: P2002 on create → returns the cart the concurrent request created', async () => {
    const { t, auth, cart, state } = setup();
    state.abandoned = null; // no abandoned cart → create path
    t.m.cart.create.mockImplementationOnce(() => {
      state.active = { ...cart, items: [] };
      return Promise.reject(p2002());
    });
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(cart.id);
    expect(t.m.cart.create).toHaveBeenCalledTimes(1);
  });

  it('POST /cart/items reactivates the abandoned cart and adds the line to it (items kept)', async () => {
    const { t, auth, cart } = setup();
    t.m.productVariant.findUnique.mockResolvedValue(variantCheck());
    t.m.cartItem.findUnique.mockResolvedValue(null);
    t.m.cartItem.count.mockResolvedValue(1);
    const res = await request(t.app)
      .post('/api/v1/cart/items')
      .set(auth)
      .send({ variantId: IDS.vOther, quantity: 1 });
    expect(res.status).toBe(201);
    expect(t.m.cartItem.create.mock.calls[0]?.[0].data).toMatchObject({ cartId: cart.id });
    expect(t.m.cart.create).not.toHaveBeenCalled();
    expect(t.m.cartItem.delete).not.toHaveBeenCalled();
  });

  it('other errors during reactivation are not swallowed', async () => {
    const { t, auth } = setup();
    t.m.cart.updateMany.mockRejectedValueOnce(new Error('lock wait timeout'));
    const res = await request(t.app).get('/api/v1/cart').set(auth);
    expect(res.status).toBe(500);
    expect(t.m.cart.create).not.toHaveBeenCalled();
  });
});
