/**
 * Pure helpers for the materialized-path category tree — DATABASE_DESIGN.md §7.1:
 * `path` = `/rootId/childId/…/selfId/` (max depth 3), `depth` 1 = root.
 */
export const MAX_CATEGORY_DEPTH = 3;

/** Ancestor ids root → self (self included, last). */
export function idsFromPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export function childPath(parentPath: string | null, id: string): string {
  return `${parentPath ?? '/'}${id}/`;
}

/** True when `candidatePath` belongs to `id` itself or one of its descendants. */
export function isSelfOrDescendant(candidatePath: string, id: string): boolean {
  return candidatePath.includes(`/${id}/`);
}

/** Levels below `rootDepth` in a subtree (0 = leaf). */
export function subtreeHeight(rootDepth: number, subtreeDepths: readonly number[]): number {
  return subtreeDepths.reduce((max, d) => Math.max(max, d - rootDepth), 0);
}

export interface PathRow {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

/** New path/depth for every descendant when the subtree root moves from `oldPath` to `newPath`. */
export function rebaseSubtree(
  rows: readonly PathRow[],
  oldPath: string,
  newPath: string,
  depthDelta: number,
): { id: string; path: string; depth: number }[] {
  return rows
    .filter((row) => row.path !== oldPath && row.path.startsWith(oldPath))
    .map((row) => ({
      id: row.id,
      path: `${newPath}${row.path.slice(oldPath.length)}`,
      depth: row.depth + depthDelta,
    }));
}

export interface TreeInput {
  readonly id: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly name: string;
  /** Count of products directly in this category. */
  readonly ownProductCount: number;
}

export type TreeNode<T> = T & { productCount: number; children: TreeNode<T>[] };

export interface BuildTreeOptions {
  /**
   * `drop` (storefront): a node whose parent is not in the set is hidden with its subtree (an
   * inactive parent hides its children). `root` (admin filters): orphans are shown as roots.
   */
  readonly orphans: 'drop' | 'root';
  /** Prune nodes deeper than this level (counts still include the pruned subtree). */
  readonly maxDepth?: number;
}

/**
 * Builds a sorted tree (sortOrder, then name) with `productCount` rolled up over descendants
 * (a product has exactly one category, so the sum never double-counts).
 */
export function buildTree<T extends TreeInput>(
  rows: readonly T[],
  options: BuildTreeOptions,
): TreeNode<T>[] {
  const nodes = new Map<string, TreeNode<T>>();
  for (const row of rows) nodes.set(row.id, { ...row, productCount: 0, children: [] });
  const roots: TreeNode<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
    if (parent !== undefined) parent.children.push(node);
    else if (node.parentId === null || options.orphans === 'root') roots.push(node);
  }
  const compare = (a: TreeNode<T>, b: TreeNode<T>): number =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
  const finish = (node: TreeNode<T>, level: number): number => {
    node.children.sort(compare);
    let total = node.ownProductCount;
    for (const child of node.children) total += finish(child, level + 1);
    node.productCount = total;
    if (options.maxDepth !== undefined && level >= options.maxDepth) node.children = [];
    return total;
  };
  roots.sort(compare);
  for (const root of roots) finish(root, 1);
  return roots;
}
