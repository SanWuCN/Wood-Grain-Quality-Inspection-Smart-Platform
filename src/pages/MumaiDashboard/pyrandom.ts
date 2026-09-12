/**
 * CPython `random` 的 MT19937 移植（只用到 seed / random / uniform）。
 *
 * 为什么要这个而不是随便一个 seeded PRNG：
 * 训练验证页要跑的两个终端演示脚本（`terminal_train_log.py`、
 * `terminal_distill.py`）都是 `random.seed(3407)` + `random.uniform(...)`。
 * 前端如果用自己的伪随机，屏幕上的 loss / mAP / gpu 显存就和脚本打印的
 * 对不上 —— 排练时一边开着终端、一边开着平台，两边数字不一致比不显示还糟。
 * 逐位复现 CPython 之后，「平台控制台跑出来的就是那个脚本的输出」这句话才成立。
 *
 * 实现严格照 `CPython/Modules/_randommodule.c`：
 *   seed(int)  → init_by_array([seed])       （整数种子按 32 位一组装 key）
 *   random()   → genrand_res53()
 *   uniform(a, b) → a + (b-a) * random()
 *
 * 32 位溢出用 `Math.imul` + `>>> 0` 保证和 C 的 uint32_t 一致。
 * 已用 `random.seed(3407)` 前 5 个 `random()` 与 3 个 `uniform(-0.18,0.22)`
 * 逐位比对通过。
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

function initGenrand(mt: Uint32Array, s: number) {
  mt[0] = s >>> 0;
  for (let i = 1; i < N; i += 1) {
    const prev = mt[i - 1];
    mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30)) >>> 0) + i) >>> 0;
  }
}

function initByArray(mt: Uint32Array, key: number[]) {
  let i = 1;
  let j = 0;
  initGenrand(mt, 19650218);
  let k = Math.max(N, key.length);
  for (; k; k -= 1) {
    const prev = mt[i - 1];
    mt[i] =
      (((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) >>> 0) + key[j] + j) >>> 0;
    i += 1;
    j += 1;
    if (i >= N) {
      mt[0] = mt[N - 1];
      i = 1;
    }
    if (j >= key.length) j = 0;
  }
  for (k = N - 1; k; k -= 1) {
    const prev = mt[i - 1];
    mt[i] =
      (((mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) >>> 0) - i) >>> 0;
    i += 1;
    if (i >= N) {
      mt[0] = mt[N - 1];
      i = 1;
    }
  }
  mt[0] = 0x80000000;
}

export type PyRandom = {
  random: () => number;
  uniform: (a: number, b: number) => number;
};

export function makePyRandom(seed: number): PyRandom {
  const mt = new Uint32Array(N);
  // Python 对整数种子先取绝对值，再按 32 位一组装成 key（seed=3407 → [3407]）
  const key: number[] = [];
  let rest = Math.abs(Math.trunc(seed));
  do {
    key.push(rest >>> 0);
    rest = Math.floor(rest / 4294967296);
  } while (rest > 0);
  initByArray(mt, key);

  let index = N;

  const genrandUint32 = () => {
    if (index >= N) {
      let y = 0;
      let kk = 0;
      for (; kk < N - M; kk += 1) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk += 1) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      }
      y = ((mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0)) >>> 0;
      index = 0;
    }
    let y = mt[index];
    index += 1;
    y = (y ^ (y >>> 11)) >>> 0;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y;
  };

  const random = () => {
    // genrand_res53：两个 32 位随机数拼成 53 位尾数
    const a = genrandUint32() >>> 5;
    const b = genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  };

  return { random, uniform: (a, b) => a + (b - a) * random() };
}

/** Python 的 round()：四舍六入五成双（银行家舍入），与 JS 的 Math.round 不同 */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python f"{x:.Nf}" 的口径，保留给需要严格对齐的场合 */
export function pyFixed(value: number, digits: number): string {
  return value.toFixed(digits);
}
