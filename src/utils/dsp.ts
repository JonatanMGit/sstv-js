/**
 * Digital Signal Processing utilities for SSTV
 */

/**
 * Complex number class for baseband processing
 */
export class Complex {
    constructor(public real: number = 0, public imag: number = 0) { }

    set(real: number, imag: number = 0): Complex {
        this.real = real;
        this.imag = imag;
        return this;
    }

    setComplex(other: Complex): Complex {
        this.real = other.real;
        this.imag = other.imag;
        return this;
    }

    norm(): number {
        return this.real * this.real + this.imag * this.imag;
    }

    abs(): number {
        return Math.sqrt(this.norm());
    }

    arg(): number {
        return Math.atan2(this.imag, this.real);
    }

    mul(other: Complex): Complex {
        const tmp = this.real * other.real - this.imag * other.imag;
        this.imag = this.real * other.imag + this.imag * other.real;
        this.real = tmp;
        return this;
    }

    mulScalar(value: number): Complex {
        this.real *= value;
        this.imag *= value;
        return this;
    }

    div(value: number): Complex {
        this.real /= value;
        this.imag /= value;
        return this;
    }
}

/**
 * Numerically controlled oscillator (Phasor)
 */
export class Phasor {
    private value: Complex;
    private delta: Complex;

    constructor(freq: number, sampleRate: number) {
        this.value = new Complex(1, 0);
        const omega = 2 * Math.PI * freq / sampleRate;
        this.delta = new Complex(Math.cos(omega), Math.sin(omega));
    }

    rotate(): Complex {
        // Multiply and normalize to prevent drift
        this.value.mul(this.delta);
        const abs = this.value.abs();
        this.value.div(abs);
        return this.value;
    }
}

/**
 * FM Demodulator using phase difference
 */
export class FrequencyModulation {
    private prevPhase: number = 0;
    private readonly scale: number;
    private readonly Pi: number = Math.PI;
    private readonly TwoPi: number = 2 * Math.PI;

    constructor(bandwidth: number, sampleRate: number) {
        this.scale = sampleRate / (bandwidth * Math.PI);
    }

    private wrap(value: number): number {
        if (value < -this.Pi) return value + this.TwoPi;
        if (value > this.Pi) return value - this.TwoPi;
        return value;
    }

    demod(input: Complex): number {
        const phase = input.arg();
        const delta = this.wrap(phase - this.prevPhase);
        this.prevPhase = phase;
        return this.scale * delta;
    }
}

/**
 * Kaiser window for FIR filter design
 */
export class Kaiser {
    private summands: number[];

    constructor() {
        // i0(x) converges for x inside -3*Pi:3*Pi in less than 35 iterations
        this.summands = new Array(35);
    }

    private square(value: number): number {
        return value * value;
    }

    private i0(x: number): number {
        this.summands[0] = 1;
        let val = 1;
        for (let n = 1; n < this.summands.length; n++) {
            val *= x / (2 * n);
            this.summands[n] = this.square(val);
        }
        // Sort for numerical stability (Kahan summation approach)
        this.summands.sort((a, b) => a - b);
        let sum = 0;
        for (let n = this.summands.length - 1; n >= 0; n--) {
            sum += this.summands[n];
        }
        return sum;
    }

    window(a: number, n: number, N: number): number {
        return this.i0(Math.PI * a * Math.sqrt(1 - this.square((2.0 * n) / (N - 1) - 1))) / this.i0(Math.PI * a);
    }
}

/**
 * FIR Filter design
 */
export class Filter {
    static sinc(x: number): number {
        if (x === 0) return 1;
        x *= Math.PI;
        return Math.sin(x) / x;
    }

    static lowPass(cutoff: number, sampleRate: number, n: number, N: number): number {
        const f = 2 * cutoff / sampleRate;
        const x = n - (N - 1) / 2.0;
        return f * Filter.sinc(f * x);
    }
}

/**
 * Complex convolution (FIR filter for complex signals)
 */
export class ComplexConvolution {
    public readonly length: number;
    public readonly taps: Float32Array;
    private readonly real: Float32Array;
    private readonly imag: Float32Array;
    private sum: Complex;
    private pos: number = 0;

    constructor(length: number) {
        this.length = length;
        this.taps = new Float32Array(length);
        this.real = new Float32Array(length);
        this.imag = new Float32Array(length);
        this.sum = new Complex();
    }

    push(input: Complex): Complex {
        this.real[this.pos] = input.real;
        this.imag[this.pos] = input.imag;
        if (++this.pos >= this.length) this.pos = 0;

        this.sum.set(0, 0);
        let p = this.pos;
        for (let i = 0; i < this.length; i++) {
            this.sum.real += this.taps[i] * this.real[p];
            this.sum.imag += this.taps[i] * this.imag[p];
            if (++p >= this.length) p = 0;
        }
        return this.sum;
    }
}

/**
 * Simple moving sum using tree structure for efficiency
 */
export class SimpleMovingSum {
    private readonly tree: Float32Array;
    private leaf: number;
    public readonly length: number;

    constructor(length: number) {
        this.length = length;
        this.tree = new Float32Array(2 * length);
        this.leaf = length;
    }

    add(input: number): void {
        this.tree[this.leaf] = input;
        let child = this.leaf;
        let parent = Math.floor(child / 2);
        while (parent > 0) {
            this.tree[parent] = this.tree[child] + this.tree[child ^ 1];
            child = parent;
            parent = Math.floor(parent / 2);
        }
        if (++this.leaf >= this.tree.length) {
            this.leaf = this.length;
        }
    }

    sum(): number {
        return this.tree[1];
    }

    sumAndAdd(input: number): number {
        this.add(input);
        return this.sum();
    }
}

/**
 * Simple moving average
 */
export class SimpleMovingAverage extends SimpleMovingSum {
    avg(input: number): number {
        return this.sumAndAdd(input) / this.length;
    }
}

/**
 * Delay line
 */
export class Delay {
    public readonly length: number;
    private readonly buf: Float32Array;
    private pos: number = 0;

    constructor(length: number) {
        this.length = length;
        this.buf = new Float32Array(length);
    }

    push(input: number): number {
        const tmp = this.buf[this.pos];
        this.buf[this.pos] = input;
        if (++this.pos >= this.length) this.pos = 0;
        return tmp;
    }
}

/**
 * Schmitt trigger with hysteresis
 */
export class SchmittTrigger {
    private previous: boolean = false;

    constructor(private low: number, private high: number) { }

    latch(input: number): boolean {
        if (this.previous) {
            if (input < this.low) this.previous = false;
        } else {
            if (input > this.high) this.previous = true;
        }
        return this.previous;
    }

    reset(): void {
        this.previous = false;
    }
}
