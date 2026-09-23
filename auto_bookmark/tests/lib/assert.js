// 最小のテストレジストリとアサーション（node不要。ブラウザのESモジュールとして動く）
//
// 使い方:
//   import { describe, test, assert, assertEqual, lazy } from "./assert.js";
//   describe("グループ名", () => {
//     const ctx = lazy(async () => { ...重い共通セットアップ...; return { ... }; });
//     test("個別の主張", async () => { const c = await ctx(); assert(c.foo === 1, "foo は 1 のはず"); });
//   });
// describe() 内の登録は同期的に行い、実際の実行は run.html 側の runAll() が後でまとめて行う。

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert(condition, message) {
  if (!condition) throw new AssertionError(message || "assertion failed");
}

// JSON化できるプレーンな値（文字列・数値・真偽値・配列・プレーンオブジェクト）の比較にのみ使う
export function assertEqual(actual, expected, message) {
  const a = stringify(actual);
  const e = stringify(expected);
  if (a !== e) {
    throw new AssertionError((message ? message + ": " : "") + "expected " + e + " but got " + a);
  }
}

export function assertMatch(text, pattern, message) {
  if (!pattern.test(String(text ?? ""))) {
    throw new AssertionError((message ? message + ": " : "") + stringify(text) + " does not match " + pattern);
  }
}

export function assertIncludes(haystack, needle, message) {
  const ok = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack ?? "").includes(needle);
  if (!ok) {
    throw new AssertionError((message ? message + ": " : "") + stringify(haystack) + " does not include " + stringify(needle));
  }
}

function stringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

// ---- レジストリ ----

const suites = [];
let currentSuite = null;

export function describe(name, register) {
  const suite = { name, tests: [] };
  suites.push(suite);
  const previous = currentSuite;
  currentSuite = suite;
  try {
    register();
  } finally {
    currentSuite = previous;
  }
}

export function test(name, fn) {
  if (!currentSuite) throw new Error('test("' + name + '") must be called inside describe()');
  currentSuite.tests.push({ name, fn });
}

/** 複数の test() が共有する非同期セットアップを、初回の呼び出し時にだけ実行して結果をキャッシュする */
export function lazy(setup) {
  let promise = null;
  return () => (promise ??= setup());
}

/**
 * 登録済みの全テストを、登録順（describe内はtest追加順）に直列実行する。
 * @param {{onEach?: (result: object) => void}} [options]
 * @returns {Promise<{suite: string, name: string, ok: boolean, ms: number, error?: string, stack?: string}[]>}
 */
export async function runAll({ onEach } = {}) {
  const results = [];
  for (const suite of suites) {
    for (const t of suite.tests) {
      const startedAt = performance.now();
      const result = { suite: suite.name, name: t.name };
      try {
        await t.fn();
        result.ok = true;
      } catch (error) {
        result.ok = false;
        result.error = (error && error.message) || String(error);
        result.stack = (error && error.stack) || "";
      }
      result.ms = Math.round(performance.now() - startedAt);
      results.push(result);
      onEach?.(result);
    }
  }
  return results;
}
