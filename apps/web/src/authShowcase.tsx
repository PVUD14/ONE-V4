/**
 * ONE · The brand panel of the signed-out pages: the Infinity Loop sign-in, redrawn in
 * Momentum (design inventory unified/sign-in.html and sign-in-mobile.html, SIGN-IN-NOTES.md).
 *
 * Luminous ∞ ribbons (the Bernoulli lemniscate, the "8" in ai8ht) with an orange spark comet
 * and a cyan comet travelling them, seeded drifting particles, the chrome logo's lens igniting,
 * LEARN | PREPARE | BUILD | GROW lighting up in turn, and the headline rising out of a mask.
 * Everything here is decoration and fixed product copy: no person, figure or score.
 *
 * The motion is CSS keyframes (styles/sign-in.css). This file only builds the geometry, which
 * is deterministic so every render is identical, and runs the two timed pieces: the entrance
 * ("played", after the fonts are ready, capped at 800ms, plus a 200ms settle) and the stage
 * chip cycle. With reduced motion, or without matchMedia, the final state shows at once: all
 * four stages lit, no comets, no entrance.
 */
import { useEffect, useState } from 'react';
import { BrandLogo } from './brand.js';

export const stageNames = ['LEARN', 'PREPARE', 'BUILD', 'GROW'] as const;

/** True when the person (or the environment) has not allowed motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The entrance plays once per mount: after the fonts are ready (capped at 800ms) and a 200ms settle. */
export function useSignInPlay(): { readonly motion: boolean; readonly played: boolean } {
  const [motion] = useState(() => !prefersReducedMotion());
  const [played, setPlayed] = useState(!motion);
  useEffect(() => {
    if (!motion) return undefined;
    let cancelled = false;
    let settle: number | undefined;
    const cap = new Promise<void>((resolve) => { window.setTimeout(resolve, 800); });
    const fonts = typeof document !== 'undefined' && document.fonts ? document.fonts.ready.then(() => undefined) : cap;
    void Promise.race([fonts, cap]).then(() => {
      if (!cancelled) settle = window.setTimeout(() => setPlayed(true), 200);
    });
    return () => { cancelled = true; if (settle !== undefined) window.clearTimeout(settle); };
  }, [motion]);
  return { motion, played };
}

/** One stage lit at a time, 1.2s each, from +900ms; all four lit when motion is off. */
function useStageCycle(motion: boolean, played: boolean): number | 'all' | null {
  const [lit, setLit] = useState<number | 'all' | null>(motion ? null : 'all');
  useEffect(() => {
    if (!motion || !played) return undefined;
    let interval: number | undefined;
    let k = 0;
    const step = (): void => { setLit(k % stageNames.length); k += 1; };
    const start = window.setTimeout(() => { step(); interval = window.setInterval(step, 1200); }, 900);
    return () => { window.clearTimeout(start); if (interval !== undefined) window.clearInterval(interval); };
  }, [motion, played]);
  return lit;
}

/* ---------- ∞ geometry: Bernoulli lemniscate ---------- */
function lemniscate(cx: number, cy: number, rx: number, ry: number, n = 240): string {
  const b = ry * 2 * Math.SQRT2;
  let d = '';
  for (let j = 0; j <= n; j += 1) {
    const t = Math.PI / 2 + (2 * Math.PI * j) / n;
    const s = Math.sin(t);
    const c = Math.cos(t);
    const den = 1 + s * s;
    d += `${j ? 'L' : 'M'}${(cx + (rx * c) / den).toFixed(2)} ${(cy + (b * s * c) / den).toFixed(2)}`;
  }
  return `${d}Z`;
}

interface Ribbon { readonly rx: number; readonly ry: number; readonly rot: number; readonly dur: number; readonly glow?: number; readonly core: number; readonly op: number; readonly da: string; readonly comet?: 'c1' | 'c2' }
interface LoopSpec { readonly key: 'd' | 'm'; readonly w: number; readonly h: number; readonly cx: number; readonly cy: number; readonly grad: readonly [number, number, number, number]; readonly ribbons: readonly Ribbon[]; readonly sparkHead: readonly [number, number] }

const LOOPS: readonly LoopSpec[] = [
  {
    key: 'd', w: 900, h: 900, cx: 430, cy: 455, grad: [10, 300, 870, 610], sparkHead: [11, 5],
    ribbons: [
      { rx: 420, ry: 212, rot: -7, dur: 26, glow: 7.2, core: 1.8, op: 0.75, da: '34 10 6 50' },
      { rx: 394, ry: 190, rot: -3, dur: 20, glow: 12, core: 3, op: 1, da: '46 8 18 28', comet: 'c1' },
      { rx: 368, ry: 170, rot: 2, dur: 23, core: 2, op: 0.9, da: '28 14 40 18', comet: 'c2' },
      { rx: 440, ry: 236, rot: 6, dur: 30, core: 1.1, op: 0.5, da: '60 40' },
      { rx: 344, ry: 148, rot: 4, dur: 34, core: 0.9, op: 0.34, da: '22 18 10 50' },
    ],
  },
  {
    key: 'm', w: 390, h: 340, cx: 195, cy: 168, grad: [-10, 100, 400, 240], sparkHead: [8, 3.6],
    ribbons: [
      { rx: 200, ry: 92, rot: -7, dur: 26, glow: 4.5, core: 1.4, op: 0.75, da: '34 10 6 50' },
      { rx: 186, ry: 80, rot: -3, dur: 20, glow: 7, core: 2.2, op: 1, da: '46 8 18 28', comet: 'c1' },
      { rx: 172, ry: 70, rot: 2, dur: 23, core: 1.6, op: 0.9, da: '28 14 40 18', comet: 'c2' },
      { rx: 210, ry: 104, rot: 6, dur: 30, core: 1, op: 0.5, da: '60 40' },
    ],
  },
];

const PATHS: Record<'d' | 'm', readonly string[]> = {
  d: LOOPS[0]!.ribbons.map((r) => lemniscate(LOOPS[0]!.cx, LOOPS[0]!.cy, r.rx, r.ry)),
  m: LOOPS[1]!.ribbons.map((r) => lemniscate(LOOPS[1]!.cx, LOOPS[1]!.cy, r.rx, r.ry)),
};

function Ribbons({ spec }: { readonly spec: LoopSpec }): React.ReactElement {
  const gid = `si-rg-${spec.key}`;
  const [x1, y1, x2, y2] = spec.grad;
  return <svg className={`si-ribbons si-ribbons-${spec.key} en`} viewBox={`0 0 ${spec.w} ${spec.h}`} preserveAspectRatio="xMinYMid slice" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
        <stop offset="0" stopColor="#2B1BB8" stopOpacity=".25" /><stop offset=".22" stopColor="#4A3BF0" /><stop offset=".5" stopColor="#1E6BFF" />
        <stop offset=".62" stopColor="#5FB0FF" stopOpacity=".55" /><stop offset=".8" stopColor="#18C8E8" /><stop offset="1" stopColor="#18C8E8" stopOpacity=".3" />
      </linearGradient>
    </defs>
    {spec.ribbons.map((r, i) => {
      const d = PATHS[spec.key][i]!;
      const stroke = `url(#${gid})`;
      return <g key={i} className={`si-rb si-rb${i}`} style={{ '--rot': `${r.rot}deg`, '--dur': `${r.dur}s`, transformOrigin: `${spec.cx}px ${spec.cy}px` } as React.CSSProperties}>
        {r.glow ? <>
          {/* Soft glow from stacked wide, faint strokes: an SVG blur on moving dashes drops the frame rate. */}
          <path className="si-flow" d={d} pathLength={100} stroke={stroke} strokeWidth={r.glow * 2.6} opacity={0.07} strokeDasharray={r.da} strokeLinecap="round" />
          <path className="si-flow" d={d} pathLength={100} stroke={stroke} strokeWidth={r.glow * 1.3} opacity={0.16} strokeDasharray={r.da} strokeLinecap="round" />
        </> : null}
        <path className="si-flow" d={d} pathLength={100} stroke={stroke} strokeWidth={r.core} opacity={r.op} strokeDasharray={r.da} strokeLinecap="round" />
        {r.comet === 'c1' ? <g className="si-comets">
          {/* Sunrise orange: the one warm accent on the page. */}
          <path className="si-comet si-c1 si-t" d={d} pathLength={100} stroke="#FF8A1F" strokeWidth={3} strokeLinecap="round" strokeDasharray="9 91" opacity={0.4} />
          <path className="si-comet si-c1 si-h" d={d} pathLength={100} stroke="#FF8A1F" strokeWidth={spec.sparkHead[0]} strokeLinecap="round" strokeDasharray="2.2 97.8" opacity={0.22} />
          <path className="si-comet si-c1 si-h" d={d} pathLength={100} stroke="#FF9A3D" strokeWidth={spec.sparkHead[1]} strokeLinecap="round" strokeDasharray="2.2 97.8" opacity={0.7} />
          <path className="si-comet si-c1 si-h" d={d} pathLength={100} stroke="#FFE2C2" strokeWidth={1.8} strokeLinecap="round" strokeDasharray="2.2 97.8" />
        </g> : null}
        {r.comet === 'c2' ? <g className="si-comets">
          <path className="si-comet si-c2 si-t" d={d} pathLength={100} stroke="#3FD9F2" strokeWidth={2.4} strokeLinecap="round" strokeDasharray="8 92" opacity={0.4} />
          <path className="si-comet si-c2 si-h" d={d} pathLength={100} stroke="#9FE8FF" strokeWidth={9} strokeLinecap="round" strokeDasharray="1.6 98.4" opacity={0.2} />
          <path className="si-comet si-c2 si-h" d={d} pathLength={100} stroke="#9FE8FF" strokeWidth={4} strokeLinecap="round" strokeDasharray="1.6 98.4" opacity={0.6} />
          <path className="si-comet si-c2 si-h" d={d} pathLength={100} stroke="#fff" strokeWidth={1.3} strokeLinecap="round" strokeDasharray="1.6 98.4" />
        </g> : null}
      </g>;
    })}
  </svg>;
}

/* ---------- particles (seeded, so every render is identical) ---------- */
interface Particle { readonly left: string; readonly top: string; readonly size: string; readonly o: string; readonly t: string; readonly dl: string }

function particles(kind: 'd' | 'm'): readonly Particle[] {
  let seed = 7;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const out: Particle[] = [];
  const count = kind === 'd' ? 34 : 18;
  for (let i = 0; i < count; i += 1) {
    let x: number; let y: number; let z: number; let w: number; let h: number;
    if (kind === 'd') {
      w = 900; h = 900;
      x = Math.round(20 + rnd() * 800); y = Math.round(120 + rnd() * 800); z = 1.1 + rnd() * 1.6;
      if (x > 900 - 0.2122 * y - 12) x = Math.round((900 - 0.2122 * y - 12) * rnd());
    } else {
      w = 390; h = 340;
      x = Math.round(8 + rnd() * 370); y = Math.round(60 + rnd() * 250); z = 1 + rnd() * 1.4;
    }
    out.push({
      left: `${((x / w) * 100).toFixed(2)}%`, top: `${((y / h) * 100).toFixed(2)}%`, size: `${z.toFixed(1)}px`,
      o: (0.3 + rnd() * 0.5).toFixed(2), t: `${(9 + rnd() * 10).toFixed(1)}s`, dl: `-${(rnd() * 12).toFixed(1)}s`,
    });
  }
  return out;
}

const PARTICLES = { d: particles('d'), m: particles('m') } as const;

function Particles({ kind }: { readonly kind: 'd' | 'm' }): React.ReactElement {
  return <div className={`si-parts si-parts-${kind} en`} aria-hidden="true">
    {PARTICLES[kind].map((p, i) => <i key={i} style={{ left: p.left, top: p.top, width: p.size, height: p.size, '--o': p.o, '--t': p.t, '--dl': p.dl } as React.CSSProperties} />)}
  </div>;
}

/* ---------- proof chip glyphs (from the approved page) ---------- */
function ShieldGlyph(): React.ReactElement {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M12 3.5 18.75 6v5.25c0 4.3-2.9 7.45-6.75 9.15-3.85-1.7-6.75-4.85-6.75-9.15V6z" /><path d="m9 12 2.2 2.2L15.2 10" /></svg>;
}
function LoopGlyph(): React.ReactElement {
  return <svg width="18" height="16" viewBox="0 0 26 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M13 12c-2.2-3-4-4.5-6-4.5a4.5 4.5 0 0 0 0 9c2 0 3.8-1.5 6-4.5zm0 0c2.2 3 4 4.5 6 4.5a4.5 4.5 0 0 0 0-9c-2 0-3.8 1.5-6 4.5z" /></svg>;
}
function LockGlyph(): React.ReactElement {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="5" y="10.5" width="14" height="10" rx="2.6" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></svg>;
}

export function AuthShowcase({ motion, played }: { readonly motion: boolean; readonly played: boolean }): React.ReactElement {
  const lit = useStageCycle(motion, played);
  return <aside className="auth-showcase si-panel-wrap" aria-label="About ONE">
    <div className="si-panel">
      <div className="si-slants" aria-hidden="true" />
      <Ribbons spec={LOOPS[0]!} />
      <Ribbons spec={LOOPS[1]!} />
      <Particles kind="d" />
      <Particles kind="m" />
      <div className="si-brand en">
        <span className="si-logo">
          <BrandLogo className="auth-showcase-logo" surface="dark" width={190} clearSpace="none" />
          <span className="si-glint" aria-hidden="true" />
          <span className="si-spec" aria-hidden="true" />
        </span>
      </div>
      <div className="si-copy">
        <ul className="si-stages en" aria-label="Learn, prepare, build, grow">
          {stageNames.map((stage, index) => <li key={stage} className={`si-stg${lit === 'all' || lit === index ? ' on' : ''}`} data-s={index} style={{ '--k': index * 2 } as React.CSSProperties}>{stage}{index < stageNames.length - 1 ? <i className="si-sep" aria-hidden="true" style={{ '--k': index * 2 + 1 } as React.CSSProperties} /> : null}</li>)}
        </ul>
        <h2 className="auth-showcase-title si-title en">
          <span className="si-ln"><span style={{ '--k': 0 } as React.CSSProperties}>One workspace</span></span>{' '}
          <span className="si-ln"><span style={{ '--k': 1 } as React.CSSProperties}>from learning to</span></span>{' '}
          <span className="si-ln"><span className="si-g" style={{ '--k': 2 } as React.CSSProperties}>landing the role.</span></span>
        </h2>
        <p className="si-lede en">Build <b>verified evidence</b>, see your readiness as an advisory band, and walk into interviews prepared. Your record stays yours.</p>
        <ul className="si-proof en" aria-label="What ONE promises">
          <li style={{ '--k': 0 } as React.CSSProperties}><ShieldGlyph />Verified evidence</li>
          <li style={{ '--k': 1 } as React.CSSProperties}><LoopGlyph />A band, never a score</li>
          <li style={{ '--k': 2 } as React.CSSProperties}><LockGlyph />Never shared with employers</li>
        </ul>
      </div>
    </div>
    <span className="si-edge en" aria-hidden="true"><span className="si-edge-run" /></span>
  </aside>;
}
