/**
 * Keys of `T` that are genuinely optional (declared with `?`), as opposed to
 * required keys whose value merely happens to include `undefined`.
 */
// biome-ignore lint/complexity/noBannedTypes: the standard "is this key optional" idiom needs the literal empty-object type, not `object`/`unknown`
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];

/**
 * A `Partial<T>`-like override type for test fixture builders, except that
 * `T`'s already-optional keys also accept an explicit `undefined` — so a
 * fixture override like `makeSession({ endedAt: undefined })` can
 * deliberately clear a builder's own default value under the project's
 * `exactOptionalPropertyTypes` setting, which otherwise treats an explicit
 * `undefined` as distinct from an omitted key. Required keys are left alone:
 * widening them too would let an override's spread silently produce an
 * object missing a value the return type still promises.
 */
export type Loosen<T> = {
  [K in keyof T]?: K extends OptionalKeys<T> ? T[K] | undefined : T[K];
};

/**
 * Asserts a merged `{ ...defaults, ...overrides: Loosen<T> }` fixture object
 * back to its exact type `T`. A `Loosen<T>`-typed override can carry a real
 * `undefined` on an optional key, which makes the merged literal's inferred
 * type technically wider than `T` under `exactOptionalPropertyTypes` even
 * though it's a value `T` accepts at runtime (an optional key holding
 * `undefined` reads identically to an omitted one) — routing through
 * `unknown` sidesteps that mismatch without silently widening `T` itself.
 */
export function asFixture<T>(value: unknown): T {
  return value as T;
}
